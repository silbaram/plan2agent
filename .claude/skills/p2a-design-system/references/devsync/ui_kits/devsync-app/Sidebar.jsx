// Sidebar.jsx — left navigation, 240px wide
function Sidebar({ view, onView }) {
  const items = [
    { group: 'Workspace', children: [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
      { id: 'issues',    label: 'Issues',    icon: 'list-checks', count: 247 },
      { id: 'board',     label: 'Board',     icon: 'kanban' },
      { id: 'repo',      label: 'Repository',icon: 'git-branch' },
    ]},
    { group: 'Project', children: [
      { id: '_pulls',  label: 'Pull requests', icon: 'git-pull-request', count: 12 },
      { id: '_runs',   label: 'CI runs',       icon: 'zap' },
      { id: '_team',   label: 'Team',          icon: 'users' },
      { id: '_calendar', label: 'Calendar',    icon: 'calendar' },
    ]},
    { group: 'Personal', children: [
      { id: '_inbox',  label: 'Inbox',         icon: 'inbox', count: 4 },
      { id: '_starred',label: 'Starred',       icon: 'star' },
      { id: '_settings',label: 'Settings',     icon: 'settings' },
    ]},
  ];

  return (
    <aside className="app__sidebar">
      <div className="sb__logo">
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
          <rect x="0" y="0" width="32" height="32" rx="6" fill="currentColor"/>
          <g stroke="#FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <circle cx="10" cy="9" r="2.2"/><circle cx="10" cy="23" r="2.2"/><circle cx="22" cy="16" r="2.2"/>
            <path d="M10 11.5 V20.5"/>
            <path d="M12.2 9 H17 a3 3 0 0 1 3 3 V14"/>
            <path d="M12.2 23 H17 a3 3 0 0 0 3 -3 V18"/>
          </g>
        </svg>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-fg-1)' }}>DevSync</span>
        <button className="tb__icon-btn" style={{ marginLeft: 'auto' }} title="New">
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="sb__item" style={{ background: 'var(--ds-bg-3)', borderColor: 'var(--ds-border-1)', cursor: 'default' }}>
        <span style={{ display: 'inline-flex', width: 18, height: 18, borderRadius: 4, background: 'var(--ds-accent-1)', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontFamily: 'var(--ds-font-mono)', fontSize: 10, fontWeight: 600 }}>D</span>
        <span style={{ flex: 1, fontWeight: 500 }}>devsync / core</span>
        <Icon name="chevron-down" size={12} style={{ color: 'var(--ds-fg-3)' }} />
      </div>

      {items.map(group => (
        <React.Fragment key={group.group}>
          <div className="sb__section">{group.group}</div>
          {group.children.map(it => {
            const active = view === it.id;
            return (
              <div key={it.id}
                className={'sb__item' + (active ? ' sb__item--active' : '')}
                onClick={() => onView && onView(it.id)}>
                <Icon name={it.icon} size={14} style={{ color: active ? 'var(--ds-accent-1)' : 'var(--ds-fg-3)' }} />
                <span>{it.label}</span>
                {it.count != null && <span className="sb__item__count">{it.count}</span>}
              </div>
            );
          })}
        </React.Fragment>
      ))}

      <div style={{ marginTop: 'auto', padding: '12px 8px 0', borderTop: '1px solid var(--ds-border-1)', marginRight: -8, marginLeft: -8 }}>
        <div className="sb__item" style={{ marginTop: 8 }}>
          <Avatar name="Jiwon Chen" size={20} style={{ borderColor: 'transparent' }} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 12, color: 'var(--ds-fg-1)' }}>Jiwon Chen</span>
            <span style={{ fontSize: 10, color: 'var(--ds-fg-3)', fontFamily: 'var(--ds-font-mono)' }}>chen.j</span>
          </div>
          <Icon name="chevron-up" size={12} style={{ marginLeft: 'auto', color: 'var(--ds-fg-3)' }} />
        </div>
      </div>
    </aside>
  );
}
window.Sidebar = Sidebar;
