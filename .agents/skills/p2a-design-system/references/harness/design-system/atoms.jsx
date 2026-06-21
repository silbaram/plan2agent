/* global React, MOCK, DotChar, DotTiny */

// ========================================================================
// Shared atomic UI for all variations
// ========================================================================

const Icon = ({ name, size = 14, stroke = 1.5, style = {} }) => {
  const paths = {
    folder: "M3 6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V6z",
    "folder-open": "M3 7a2 2 0 012-2h3l2 2h7a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM3 10h18",
    file: "M6 3h7l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2zM13 3v5h5",
    "chevron-right": "M9 6l6 6-6 6",
    "chevron-down": "M6 9l6 6 6-6",
    plus: "M12 5v14M5 12h14",
    play: "M6 4l14 8-14 8V4z",
    pause: "M6 4h4v16H6zM14 4h4v16h-4z",
    search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
    settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
    terminal: "M4 17l6-6-6-6M12 19h8",
    diff: "M12 3v18M3 12h18",
    git: "M6 3v12M18 9v12M6 15a3 3 0 106 0 3 3 0 00-6 0zM12 6a3 3 0 106 0 3 3 0 00-6 0zM18 12a3 3 0 11-6 0",
    bell: "M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9zM10 21a2 2 0 004 0",
    layers: "M12 2l10 6-10 6L2 8l10-6zM2 12l10 6 10-6M2 16l10 6 10-6",
    sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z",
    check: "M5 12l5 5L20 7",
    x: "M6 6l12 12M18 6L6 18",
    minimize: "M5 12h14",
    maximize: "M5 5h14v14H5z",
    "arrow-up": "M12 19V5M5 12l7-7 7 7",
    "arrow-down": "M12 5v14M19 12l-7 7-7-7",
    spinner: "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
    "git-branch": "M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 6a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
    history: "M3 12a9 9 0 109-9 9.74 9.74 0 00-7 3L3 9M3 3v6h6M12 7v5l3 2",
  };
  const d = paths[name] || paths.file;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="square"
      strokeLinejoin="miter"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={d} />
    </svg>
  );
};

// Provider mark — tiny 3-letter monogram
const ProviderMark = ({ provider, size = 14 }) => {
  const labels = { claude: "C", codex: "O", gemini: "G", aider: "A", cursor: "U" };
  const colors = {
    claude: "var(--p-claude)",
    codex: "var(--p-codex)",
    gemini: "var(--p-gemini)",
    aider: "var(--p-aider)",
    cursor: "var(--p-cursor)",
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        border: `1px solid ${colors[provider] || "var(--fg-3)"}`,
        color: colors[provider] || "var(--fg-3)",
        fontFamily: "var(--font-mono)",
        fontSize: size - 6,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {labels[provider] || "?"}
    </span>
  );
};

// Token counter mono pill
const TokenPill = ({ inn, out }) => (
  <span className="t-mono-s" style={{ color: "var(--fg-3)" }}>
    <span style={{ color: "var(--fg-2)" }}>{(inn / 1000).toFixed(1)}k</span>
    <span style={{ margin: "0 4px", color: "var(--fg-4)" }}>↓↑</span>
    <span style={{ color: "var(--fg-2)" }}>{(out / 1000).toFixed(1)}k</span>
  </span>
);

// Ghost button
const GButton = ({ children, accent, onClick, style = {} }) => (
  <button
    onClick={onClick}
    style={{
      padding: "5px 10px",
      fontSize: "var(--t-small)",
      fontFamily: "var(--font-sans)",
      color: accent ? "var(--accent-ink)" : "var(--fg-1)",
      background: accent ? "var(--accent)" : "transparent",
      border: `1px solid ${accent ? "var(--accent)" : "var(--border-2)"}`,
      borderRadius: "var(--r-1)",
      cursor: "pointer",
      transition: "background var(--dur-fast)",
      ...style,
    }}
  >
    {children}
  </button>
);

// Status row line for an agent (used inside variations)
const AgentRow = ({ agent, compact = false, selected = false, showDot = true }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: compact ? "6px 10px" : "10px 12px",
      background: selected ? "var(--bg-3)" : "transparent",
      borderLeft: `2px solid ${selected ? agent.providerColor : "transparent"}`,
      cursor: "pointer",
    }}
  >
    {showDot && <DotChar state={agent.state} size={2} />}
    <ProviderMark provider={agent.provider} size={14} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: "var(--t-body)", fontWeight: 500, color: "var(--fg-1)" }}>{agent.name}</span>
        <span className="t-mono-s">{agent.model}</span>
      </div>
      {!compact && (
        <div className="t-small" style={{ color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {agent.task}
        </div>
      )}
    </div>
    {!compact && <TokenPill inn={agent.tokens.in} out={agent.tokens.out} />}
  </div>
);

Object.assign(window, { Icon, ProviderMark, TokenPill, GButton, AgentRow });
