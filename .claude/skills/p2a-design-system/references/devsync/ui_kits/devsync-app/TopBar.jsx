// TopBar.jsx — 48px top bar with breadcrumb, search, actions, theme toggle
function TopBar({ view, theme, onTheme, onCmdK }) {
  const labels = {
    dashboard: 'Dashboard', issues: 'Issues', board: 'Board', repo: 'Repository',
  };
  return (
    <header className="app__topbar">
      <div className="tb__breadcrumb">
        <span>devsync</span>
        <Icon name="chevron-right" size={12} />
        <span>core</span>
        <Icon name="chevron-right" size={12} />
        <b>{labels[view] || view}</b>
      </div>
      <div className="tb__search" onClick={onCmdK} role="button">
        <Icon name="search" size={14} />
        <span>Search issues, PRs, files…</span>
        <span className="tb__kbd">⌘ K</span>
      </div>
      <div className="tb__actions">
        <button className="tb__icon-btn" title="Toggle theme" onClick={onTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
        </button>
        <button className="tb__icon-btn" title="Help">
          <Icon name="help-circle" size={14} />
        </button>
        <button className="tb__icon-btn" title="Notifications" style={{ position: 'relative' }}>
          <Icon name="bell" size={14} />
          <span style={{ position: 'absolute', top: 4, right: 4, width: 6, height: 6, background: 'var(--ds-danger-1)', borderRadius: 999, border: '1px solid var(--ds-bg-2)' }} />
        </button>
        <div style={{ width: 1, height: 18, background: 'var(--ds-border-1)', margin: '0 4px' }} />
        <Avatar name="Jiwon Chen" size={26} style={{ borderColor: 'transparent' }} />
      </div>
    </header>
  );
}
window.TopBar = TopBar;
