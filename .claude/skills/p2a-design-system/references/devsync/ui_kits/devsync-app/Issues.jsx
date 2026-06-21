// Issues.jsx — data table with filter chips, status pills, sortable cols
function Issues() {
  const [selected, setSelected] = React.useState(new Set([1, 3]));
  const [sortBy, setSortBy] = React.useState('updated');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [toast, setToast] = React.useState(null);

  const rows = [
    { id: 'DEV-1284', title: 'Refactor auth token refresh', status: 'open',      priority: 'P1', area: 'api',      assignee: 'Jiwon Chen', updated: '2m', est: '3d' },
    { id: 'DEV-1283', title: 'Flaky CI on macos-14 runner', status: 'in-review', priority: 'P2', area: 'infra',    assignee: 'Soyeon Kim', updated: '17m', est: '1d' },
    { id: 'DEV-1282', title: 'SSO logout returns 500',      status: 'blocked',   priority: 'P0', area: 'auth',     assignee: 'Hyun Park', updated: '1h', est: '4d' },
    { id: 'DEV-1281', title: 'Optimise repository tree query for >10k files', status: 'open', priority: 'P2', area: 'perf', assignee: 'Minho Kim', updated: '3h', est: '5d' },
    { id: 'DEV-1280', title: 'Add granular RBAC for team admins', status: 'in-progress', priority: 'P1', area: 'auth', assignee: 'Lila Lin', updated: '5h', est: '8d' },
    { id: 'DEV-1279', title: 'Migrate webhook payloads to v3 schema', status: 'in-review', priority: 'P3', area: 'api', assignee: 'Jiwon Chen', updated: 'yesterday', est: '2d' },
    { id: 'DEV-1278', title: 'Empty state for boards has wrong copy', status: 'open', priority: 'P3', area: 'ui', assignee: 'Soyeon Kim', updated: 'yesterday', est: '1h' },
    { id: 'DEV-1277', title: 'Kanban drag-drop drops onto wrong column on narrow screens', status: 'open', priority: 'P2', area: 'ui', assignee: 'Hyun Park', updated: '2d', est: '4h' },
    { id: 'DEV-1276', title: 'Inline edit on table loses focus on validation error', status: 'closed', priority: 'P2', area: 'ui', assignee: 'Minho Kim', updated: '3d', est: '—' },
    { id: 'DEV-1275', title: 'CLI: devsync sync ignores --branch flag',  status: 'failed',    priority: 'P1', area: 'cli',  assignee: 'Lila Lin',  updated: '3d', est: '6h' },
    { id: 'DEV-1274', title: 'Repository browser: blame view scroll desync', status: 'open',  priority: 'P3', area: 'ui',   assignee: 'Jiwon Chen', updated: '4d', est: '1d' },
    { id: 'DEV-1273', title: 'Add audit log retention policy controls',  status: 'draft',     priority: 'P2', area: 'admin',assignee: 'Soyeon Kim', updated: '5d', est: '3d' },
  ];

  const toggle = (i) => {
    const n = new Set(selected);
    n.has(i) ? n.delete(i) : n.add(i);
    setSelected(n);
  };

  const allSelected = selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((_, i) => i)));

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Issues</h1>
        <span className="page__subtitle">247 open · 1,492 total</span>
        <div className="page__actions">
          <Button variant="secondary" icon="filter" size="sm">Filter</Button>
          <Button variant="secondary" icon="sort" size="sm">Updated</Button>
          <Button variant="primary" icon="plus" size="sm">New issue</Button>
        </div>
      </div>

      <div className="filterbar">
        <button className="chip chip--applied"><Icon name="circle-dot" size={11} /> Status: Open</button>
        <button className="chip chip--applied"><Icon name="users" size={11} /> Assignee: any of 3</button>
        <button className="chip"><Icon name="plus" size={11} /> Add filter</button>
        <div className="spacer" />
        {selected.size > 0 && (
          <>
            <span className="mono muted" style={{ fontSize: 11 }}>{selected.size} selected</span>
            <Button variant="ghost" size="sm" icon="check" onClick={() => setToast({ tone: 'success', msg: `${selected.size} issues closed` })}>Close</Button>
            <Button variant="ghost" size="sm" icon="users">Assign</Button>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Button variant="ghost" size="sm" icon="more-horizontal" onClick={() => setMenuOpen(v => !v)} />
              <Menu open={menuOpen} onClose={() => setMenuOpen(false)}
                style={{ top: 'calc(100% + 4px)', right: 0 }}
                items={[
                  { icon: 'circle-dot', label: 'Change status', hint: 'S' },
                  { icon: 'star', label: 'Add to milestone' },
                  { icon: 'copy', label: 'Copy IDs', hint: '⌘ C' },
                  { divider: true },
                  { icon: 'x', label: 'Delete issues', danger: true, onClick: () => setConfirm(true) },
                ]} />
            </span>
          </>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32, paddingRight: 0 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ accentColor: 'var(--ds-accent-1)' }} />
                </th>
                <th style={{ width: 80 }}>ID</th>
                <th style={{ width: 96 }}>Status</th>
                <th>Title</th>
                <th style={{ width: 60 }}>Pri</th>
                <th style={{ width: 80 }}>Area</th>
                <th style={{ width: 160 }}>Assignee</th>
                <th style={{ width: 60 }}>Est</th>
                <th style={{ width: 88, textAlign: 'right' }} className="col-meta">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Updated <Icon name="chevron-down" size={10} /></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={selected.has(i) ? 'selected' : ''}>
                  <td style={{ paddingRight: 0 }}>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} style={{ accentColor: 'var(--ds-accent-1)' }} />
                  </td>
                  <td className="col-num">{r.id}</td>
                  <td><Status value={r.status} /></td>
                  <td className="col-title" style={{ maxWidth: 420 }}>{r.title}</td>
                  <td><Tag>{r.priority}</Tag></td>
                  <td><Tag>{r.area}</Tag></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Avatar name={r.assignee} size={18} style={{ borderColor: 'transparent' }} />
                      <span style={{ fontSize: 12, color: 'var(--ds-fg-2)' }}>{r.assignee}</span>
                    </span>
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{r.est}</td>
                  <td className="col-meta">{r.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)}
        icon="x" tone="danger" title={`Delete ${selected.size} issues?`}
        actions={<>
          <Button variant="secondary" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => { setConfirm(false); setToast({ tone: 'danger', msg: `${selected.size} issues deleted` }); }}>Delete</Button>
        </>}>
        This permanently removes the selected issues and their comment history. This can't be undone.
      </Modal>

      {toast && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 60 }}>
          <Toast tone={toast.tone} action="Undo" onAction={() => setToast(null)} onClose={() => setToast(null)}>{toast.msg}</Toast>
        </div>
      )}
    </div>
  );
}
window.Issues = Issues;
