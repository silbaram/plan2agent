/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark, TokenPill, AgentRow */

// =====================================================================
// Variation 1 — "Operator"
// VSCode/Zed-style: 3-pane layout
// Left: activity bar + sessions/projects
// Center: live agent transcript with embedded tool calls
// Right: agent inspector with dot character hero
// Vibe: Pro tool, dense, the default workhorse view
// =====================================================================

function VarOperator() {
  const activeAgent = MOCK.agents[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-1)", color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>
      {/* ── Tab strip ────────────────────────────────────── */}
      <div style={{ display: "flex", height: "var(--tab-h)", background: "var(--bg-0)", borderBottom: "1px solid var(--border-1)", alignItems: "stretch" }}>
        {MOCK.agents.slice(0, 3).map((a, i) => (
          <div key={a.id} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0 14px",
            background: i === 0 ? "var(--bg-1)" : "transparent",
            borderRight: "1px solid var(--border-1)",
            borderTop: i === 0 ? `1px solid ${a.providerColor}` : "1px solid transparent",
            cursor: "pointer",
            minWidth: 180,
          }}>
            <DotChar state={a.state} size={2} />
            <ProviderMark provider={a.provider} size={12} />
            <span style={{ fontSize: "var(--t-small)", color: i === 0 ? "var(--fg-1)" : "var(--fg-3)" }}>{a.name}</span>
            <span style={{ marginLeft: "auto", color: "var(--fg-4)", fontSize: 11 }}>×</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", padding: "0 12px", color: "var(--fg-3)" }}>
          <Icon name="plus" size={12} />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 14px", color: "var(--fg-3)" }}>
          <span className="t-mono-s">checkout-v2</span>
          <span style={{ color: "var(--fg-4)" }}>·</span>
          <span className="t-mono-s">main</span>
        </div>
      </div>

      {/* ── Main 3-pane area ─────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Activity bar */}
        <div style={{ width: "var(--activitybar-w)", background: "var(--bg-0)", borderRight: "1px solid var(--border-1)", display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0", gap: 18 }}>
          {[
            { name: "layers", active: true },
            { name: "folder", active: false },
            { name: "git-branch", active: false },
            { name: "history", active: false },
            { name: "sparkle", active: false },
            { name: "search", active: false },
          ].map((it) => (
            <div key={it.name} style={{ position: "relative", padding: 8, color: it.active ? "var(--fg-1)" : "var(--fg-3)" }}>
              {it.active && <span style={{ position: "absolute", left: -12, top: 6, bottom: 6, width: 2, background: "var(--accent)" }} />}
              <Icon name={it.name} size={18} stroke={1.5} />
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ color: "var(--fg-3)", padding: 8 }}><Icon name="settings" size={18} /></div>
        </div>

        {/* Sidebar */}
        <div style={{ width: "var(--sidebar-w)", background: "var(--bg-2)", borderRight: "1px solid var(--border-1)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="t-micro">sessions</span>
            <span className="t-mono-s">{MOCK.sessions.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {MOCK.sessions.map((s, i) => {
              const provColor = { claude: "var(--p-claude)", codex: "var(--p-codex)", gemini: "var(--p-gemini)", aider: "var(--p-aider)" }[s.agent];
              return (
                <div key={s.id} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px",
                  borderLeft: `2px solid ${i === 0 ? provColor : "transparent"}`,
                  background: i === 0 ? "var(--bg-3)" : "transparent",
                  cursor: "pointer",
                }}>
                  <DotTiny state={s.state === "tool" ? "active" : s.state === "thinking" ? "active" : s.state} size={2} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--t-body)", color: "var(--fg-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                      <ProviderMark provider={s.agent} size={11} />
                      <span className="t-mono-s">{s.ts}</span>
                      {s.unread > 0 && <span style={{ marginLeft: 4, color: "var(--accent)", fontSize: 10 }}>●</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: "1px solid var(--border-1)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="plus" size={14} />
            <span className="t-small" style={{ color: "var(--fg-2)" }}>new session</span>
            <span style={{ marginLeft: "auto" }} className="t-mono-s">⌘N</span>
          </div>
        </div>

        {/* Center transcript */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg-1)" }}>
          {/* Sub-header */}
          <div style={{ height: 44, padding: "0 18px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--border-1)" }}>
            <DotChar state={activeAgent.state} size={2} />
            <span style={{ fontSize: "var(--t-h3)", fontWeight: 700 }}>checkout 401 fix</span>
            <span className="t-mono-s">·</span>
            <span className="t-mono-s">{activeAgent.duration}</span>
            <span style={{ flex: 1 }} />
            <TokenPill inn={activeAgent.tokens.in} out={activeAgent.tokens.out} />
            <button style={{ padding: "5px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", color: "var(--fg-2)", fontSize: "var(--t-small)" }}>
              pause
            </button>
          </div>

          {/* Transcript */}
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}>
            {MOCK.transcript.map((m, i) => <TranscriptRow key={i} m={m} />)}
            {/* live input echo */}
            <div style={{ marginTop: 14, padding: "12px 14px", border: "1px solid var(--border-2)", borderRadius: "var(--r-2)", background: "var(--bg-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span className="t-micro">message · claude code</span>
                <span style={{ flex: 1 }} />
                <span className="t-mono-s">⌘↵ to send</span>
              </div>
              <div style={{ color: "var(--fg-3)", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)" }}>
                <span style={{ color: "var(--fg-1)" }}>also write a regression test</span>
                <span style={{ display: "inline-block", width: 8, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "harness-blink 900ms steps(2) infinite" }} />
              </div>
            </div>
          </div>
        </div>

        {/* Inspector */}
        <div style={{ width: "var(--inspector-w)", background: "var(--bg-2)", borderLeft: "1px solid var(--border-1)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "20px 18px", borderBottom: "1px solid var(--border-1)", textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
              <DotChar state={activeAgent.state} size={6} />
            </div>
            <div style={{ fontSize: "var(--t-h2)", fontWeight: 700, marginBottom: 4 }}>{activeAgent.name}</div>
            <div className="t-small" style={{ color: "var(--fg-3)" }}>
              {activeAgent.state} · {activeAgent.model}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
            <div className="t-micro" style={{ marginBottom: 8 }}>active tools</div>
            {MOCK.skills.filter(s => s.state === "active" && s.agent === "claude code").map(s => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-1)" }}>
                <DotTiny state="active" size={2} />
                <span style={{ fontSize: "var(--t-body)" }}>{s.name}</span>
              </div>
            ))}

            <div className="t-micro" style={{ marginTop: 22, marginBottom: 8 }}>sub-agents</div>
            {MOCK.subagents.filter(sa => sa.parent === "claude code").map(sa => (
              <div key={sa.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-1)" }}>
                <DotChar state={sa.state === "active" ? "thinking" : sa.state === "done" ? "done" : "idle"} size={1.5} />
                <span style={{ fontSize: "var(--t-body)" }}>{sa.name}</span>
                <span style={{ marginLeft: "auto" }} className="t-mono-s">{sa.state}</span>
              </div>
            ))}

            <div className="t-micro" style={{ marginTop: 22, marginBottom: 8 }}>changed files</div>
            {MOCK.files.filter(f => f.modified).map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", color: "var(--fg-2)" }}>
                <Icon name="file" size={12} />
                <span style={{ fontSize: "var(--t-small)", fontFamily: "var(--font-mono)" }}>{f.name}</span>
                <span style={{ marginLeft: "auto" }} className="t-mono-s" style={{ color: "var(--accent)" }}>M</span>
              </div>
            ))}

            <div className="t-micro" style={{ marginTop: 22, marginBottom: 8 }}>cost · this session</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: "var(--t-display)", fontWeight: 300, color: "var(--fg-1)", fontFamily: "var(--font-mono)" }}>$0.42</span>
              <span className="t-mono-s">USD</span>
            </div>
            <div className="t-small" style={{ color: "var(--fg-3)", marginTop: 2 }}>27.9k in · 3.1k out</div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ height: "var(--statusbar-h)", display: "flex", alignItems: "center", padding: "0 12px", gap: 14, background: "var(--bg-0)", borderTop: "1px solid var(--border-1)", color: "var(--fg-3)" }}>
        <span className="t-mono-s">⎇ feature/checkout-401</span>
        <span style={{ color: "var(--fg-4)" }}>·</span>
        <span className="t-mono-s">5 agents · 3 active</span>
        <span style={{ flex: 1 }} />
        <DotTiny state="active" size={1.5} />
        <span className="t-mono-s">connected · sonnet 4.5</span>
      </div>
    </div>
  );
}

// Transcript row renderer used by Operator and others
function TranscriptRow({ m }) {
  if (m.kind === "user") {
    return (
      <div style={{ marginBottom: 18, display: "flex", gap: 14 }}>
        <div style={{
          width: 24, height: 24, borderRadius: "var(--r-pill)",
          background: "var(--bg-3)", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, color: "var(--fg-1)", flexShrink: 0,
        }}>ㅎ</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: "var(--t-body)" }}>한민</span>
            <span className="t-mono-s">{m.ts}</span>
          </div>
          <div style={{ color: "var(--fg-1)", lineHeight: 1.55 }}>{m.body}</div>
        </div>
      </div>
    );
  }
  if (m.kind === "agent") {
    const provider = m.agent === "claude code" ? "claude" : m.agent === "codex" ? "codex" : "gemini";
    return (
      <div style={{ marginBottom: 14, display: "flex", gap: 14 }}>
        <div style={{ width: 24, height: 24, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <DotChar state="idle" size={2} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <ProviderMark provider={provider} size={12} />
            <span style={{ fontWeight: 700, fontSize: "var(--t-body)" }}>{m.agent}</span>
            <span className="t-mono-s">{m.ts}</span>
          </div>
          <div style={{ color: "var(--fg-1)", lineHeight: 1.55 }}>{m.body}</div>
        </div>
      </div>
    );
  }
  if (m.kind === "tool") {
    return (
      <div style={{ marginBottom: 6, marginLeft: 38, display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--bg-2)", border: "1px solid var(--border-1)", borderRadius: "var(--r-1)", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)" }}>
        {m.running ? <DotTiny state="active" size={1.5} /> : <DotTiny state="done" size={1.5} />}
        <span style={{ color: "var(--accent)" }}>{m.tool}</span>
        <span style={{ color: "var(--fg-3)" }}>(</span>
        <span style={{ color: "var(--fg-1)" }}>{m.arg}</span>
        <span style={{ color: "var(--fg-3)" }}>)</span>
        {m.running && <span style={{ marginLeft: "auto", color: "var(--fg-3)" }}>running…</span>}
      </div>
    );
  }
  if (m.kind === "diff") {
    return (
      <div style={{ marginBottom: 6, marginLeft: 38, padding: "8px 12px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--r-2)", display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name="diff" size={14} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)" }}>{m.file}</span>
        <span style={{ color: "var(--ok)", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)" }}>+{m.added}</span>
        <span style={{ color: "var(--err)", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)" }}>−{m.removed}</span>
        <span style={{ flex: 1 }} />
        <button style={{ padding: "3px 8px", fontSize: "var(--t-small)", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", color: "var(--fg-2)" }}>view</button>
        <button style={{ padding: "3px 8px", fontSize: "var(--t-small)", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: "var(--r-1)" }}>apply</button>
      </div>
    );
  }
  return null;
}

window.VarOperator = VarOperator;
window.TranscriptRow = TranscriptRow;
