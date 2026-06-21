/* global React */
// Custom IDE chrome for harness — replaces MacWindow which doesn't fit
// the dark, flat aesthetic. Title bar with traffic lights + project name.

function HarnessChrome({ title = "harness", subtitle, children, accent }) {
  return (
    <div style={{
      width: "100%", height: "100%",
      background: "var(--bg-1)",
      border: "1px solid var(--border-2)",
      borderRadius: 8,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      boxShadow: "0 24px 64px -16px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(0 0 0 / 0.4)",
    }}>
      <div style={{
        height: 36, flexShrink: 0,
        background: "var(--bg-0)",
        borderBottom: "1px solid var(--border-1)",
        display: "flex", alignItems: "center",
        padding: "0 14px", gap: 14,
      }}>
        <div style={{ display: "flex", gap: 7 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ED6A5E" }} />
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#F5BF4F" }} />
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#62C554" }} />
        </div>
        <div style={{ flex: 1, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {accent && <span style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)" }}>{title}</span>
          {subtitle && <>
            <span style={{ color: "var(--fg-4)", fontSize: 11 }}>·</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{subtitle}</span>
          </>}
        </div>
        <div style={{ width: 50 }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

window.HarnessChrome = HarnessChrome;
