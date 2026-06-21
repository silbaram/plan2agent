// Kanban.jsx — board with status columns + draggable-looking cards
function Kanban() {
  const cols = [
    {
      key: 'backlog', title: 'Backlog', tone: 'neutral',
      items: [
        { id: 'DEV-1290', title: 'Add team-level OAuth scopes', priority: 'P2', area: 'auth', assignees: ['Jiwon Chen'], comments: 3, est: '5d' },
        { id: 'DEV-1289', title: 'Webhook retry queue with exponential backoff', priority: 'P3', area: 'api', assignees: ['Soyeon Kim', 'Lila Lin'], comments: 1, est: '3d' },
        { id: 'DEV-1288', title: 'Settings → Integrations page redesign', priority: 'P3', area: 'ui', assignees: ['Hyun Park'], comments: 0, est: '4d' },
        { id: 'DEV-1287', title: 'Migrate legacy /v1 endpoints to /v3', priority: 'P2', area: 'api', assignees: ['Minho Kim'], comments: 7, est: '8d' },
      ],
    },
    {
      key: 'in-progress', title: 'In progress', tone: 'info',
      items: [
        { id: 'DEV-1284', title: 'Refactor auth token refresh', priority: 'P1', area: 'api', assignees: ['Jiwon Chen'], comments: 5, est: '3d', linked: 'PR #482' },
        { id: 'DEV-1280', title: 'Add granular RBAC for team admins', priority: 'P1', area: 'auth', assignees: ['Lila Lin', 'Hyun Park'], comments: 12, est: '8d' },
        { id: 'DEV-1281', title: 'Optimise repository tree query for >10k files', priority: 'P2', area: 'perf', assignees: ['Minho Kim'], comments: 2, est: '5d' },
      ],
    },
    {
      key: 'in-review', title: 'In review', tone: 'info',
      items: [
        { id: 'DEV-1283', title: 'Flaky CI on macos-14 runner', priority: 'P2', area: 'infra', assignees: ['Soyeon Kim'], comments: 4, est: '1d', linked: 'PR #481' },
        { id: 'DEV-1279', title: 'Migrate webhook payloads to v3 schema', priority: 'P3', area: 'api', assignees: ['Jiwon Chen'], comments: 8, est: '2d', linked: 'PR #479' },
      ],
    },
    {
      key: 'done', title: 'Done', tone: 'success',
      items: [
        { id: 'DEV-1276', title: 'Inline edit on table loses focus on validation error', priority: 'P2', area: 'ui', assignees: ['Minho Kim'], comments: 2, est: '—' },
        { id: 'DEV-1272', title: 'CLI: --dry-run flag for sync command', priority: 'P3', area: 'cli', assignees: ['Lila Lin'], comments: 1, est: '—' },
        { id: 'DEV-1270', title: 'Dark mode regression in modal backdrop', priority: 'P2', area: 'ui', assignees: ['Hyun Park'], comments: 3, est: '—' },
      ],
    },
  ];

  return (
    <div className="page" style={{ height: 'calc(100vh - var(--kit-topbar-h))' }}>
      <div className="page__header">
        <h1 className="page__title">Sprint 24</h1>
        <span className="page__subtitle">May 13 – May 27 · 38/52 pts</span>
        <div className="page__actions">
          <Button variant="secondary" icon="users" size="sm">Members</Button>
          <Button variant="secondary" icon="filter" size="sm">Filter</Button>
          <Button variant="primary" icon="plus" size="sm">New issue</Button>
        </div>
      </div>

      <div className="kanban">
        {cols.map(col => (
          <div className="kanban__col" key={col.key}>
            <div className="kanban__col__header">
              <span className="badge__dot" style={{ background: `var(--ds-${col.tone}-1)`, width: 8, height: 8, borderRadius: 999 }} />
              <span className="kanban__col__title">{col.title}</span>
              <span className="kanban__col__count">{col.items.length}</span>
              <button className="tb__icon-btn" style={{ width: 22, height: 22 }} title="Add"><Icon name="plus" size={12} /></button>
            </div>
            <div className="kanban__list">
              {col.items.map(it => (
                <div className="kanban__card" key={it.id}>
                  <div className="kanban__card__meta">
                    <span>{it.id}</span>
                    <span className="muted">·</span>
                    <Tag>{it.priority}</Tag>
                    <Tag>{it.area}</Tag>
                  </div>
                  <div className="kanban__card__title">{it.title}</div>
                  {it.linked && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ds-info-fg)' }}>
                      <Icon name="git-pull-request" size={11} /> {it.linked}
                    </div>
                  )}
                  <div className="kanban__card__footer">
                    <AvatarStack names={it.assignees} max={3} size={20} />
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--ds-fg-3)', fontFamily: 'var(--ds-font-mono)' }}>
                      {it.comments > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <Icon name="message-square" size={11} /> {it.comments}
                        </span>
                      )}
                      <span>{it.est}</span>
                    </div>
                  </div>
                </div>
              ))}
              <button className="kanban__card" style={{ cursor: 'pointer', color: 'var(--ds-fg-3)', justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6, fontSize: 12, background: 'transparent', borderStyle: 'dashed' }}>
                <Icon name="plus" size={12} /> Add issue
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
window.Kanban = Kanban;
