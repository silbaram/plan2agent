// app.jsx — top-level layout, view router, theme toggle, command palette stub
function CommandPalette({ open, onClose }) {
  if (!open) return null;
  const items = [
    { icon: 'plus',         label: 'Create issue',          hint: '⌘ N' },
    { icon: 'git-pull-request', label: 'Open pull request',  hint: '⌘ ⇧ P' },
    { icon: 'git-branch',   label: 'Switch branch…',        hint: '⌘ B' },
    { icon: 'layout-dashboard', label: 'Go to Dashboard',   hint: 'G D' },
    { icon: 'list-checks',  label: 'Go to Issues',          hint: 'G I' },
    { icon: 'kanban',       label: 'Go to Board',           hint: 'G B' },
    { icon: 'settings',     label: 'Settings',              hint: '⌘ ,' },
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(6, 10, 20, 0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '12vh',
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, background: 'var(--ds-bg-2)',
          border: '1px solid var(--ds-border-2)',
          borderRadius: 'var(--ds-radius-md)',
          boxShadow: 'var(--ds-shadow-lg)',
          overflow: 'hidden',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--ds-border-1)' }}>
          <Icon name="search" size={14} style={{ color: 'var(--ds-fg-3)' }} />
          <input autoFocus placeholder="Type a command or search…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--ds-fg-1)', fontFamily: 'var(--ds-font-sans)', fontSize: 14 }} />
          <span className="tb__kbd">esc</span>
        </div>
        <div style={{ padding: '6px 0', maxHeight: 360, overflow: 'auto' }}>
          {items.map((it, i) => (
            <div key={it.label}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                height: 32, padding: '0 14px',
                background: i === 0 ? 'var(--ds-bg-3)' : 'transparent',
                color: 'var(--ds-fg-1)', fontSize: 13, cursor: 'pointer',
              }}>
              <Icon name={it.icon} size={14} style={{ color: 'var(--ds-fg-3)' }} />
              <span style={{ flex: 1 }}>{it.label}</span>
              <span className="tb__kbd">{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [view, setView] = React.useState('dashboard');
  const [theme, setTheme] = React.useState('dark');
  const [cmdK, setCmdK] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdK(true);
      } else if (e.key === 'Escape') {
        setCmdK(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const screen = (() => {
    switch (view) {
      case 'dashboard': return <Dashboard />;
      case 'issues':    return <Issues />;
      case 'board':     return <Kanban />;
      case 'repo':      return <Repo />;
      default:
        return (
          <div className="page">
            <div className="page__header"><h1 className="page__title">Coming soon</h1></div>
            <div style={{ background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border-1)', borderRadius: 'var(--ds-radius-md)', padding: 32, textAlign: 'center', color: 'var(--ds-fg-3)' }}>
              This screen is not part of the kit. Try the four primary views from the sidebar.
            </div>
          </div>
        );
    }
  })();

  return (
    <div className="app" data-screen-label={'devsync-' + view}>
      <TopBar view={view} theme={theme}
        onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onCmdK={() => setCmdK(true)} />
      <Sidebar view={view} onView={setView} />
      <main className="app__main">{screen}</main>
      <CommandPalette open={cmdK} onClose={() => setCmdK(false)} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
