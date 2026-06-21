// Repo.jsx — repository browser with file tree + file viewer
function Repo() {
  const [active, setActive] = React.useState('src/auth/refresh.ts');

  const tree = [
    { type: 'folder', name: '.github', open: false, depth: 0 },
    { type: 'folder', name: 'src',     open: true,  depth: 0 },
    { type: 'folder', name: 'src/api', open: true,  depth: 1 },
    { type: 'file',   name: 'src/api/routes.ts', depth: 2 },
    { type: 'file',   name: 'src/api/server.ts', depth: 2 },
    { type: 'folder', name: 'src/auth', open: true, depth: 1 },
    { type: 'file',   name: 'src/auth/index.ts',    depth: 2 },
    { type: 'file',   name: 'src/auth/refresh.ts',  depth: 2 },
    { type: 'file',   name: 'src/auth/session.ts',  depth: 2 },
    { type: 'folder', name: 'src/db',    open: false, depth: 1 },
    { type: 'folder', name: 'src/utils', open: false, depth: 1 },
    { type: 'file',   name: 'src/index.ts', depth: 1 },
    { type: 'folder', name: 'tests', open: false, depth: 0 },
    { type: 'file',   name: 'package.json',  depth: 0 },
    { type: 'file',   name: 'tsconfig.json', depth: 0 },
    { type: 'file',   name: 'README.md',     depth: 0 },
  ];

  // Pre-rendered token map (lines × spans). Simple enough for a kit.
  const code = [
    [['kw','import'],['',' { '],['','SignJWT, jwtVerify'],['',' } '],['kw','from'],['',' '],['str',"'jose'"],['pn',';']],
    [['kw','import'],['',' { '],['','db'],['',' } '],['kw','from'],['',' '],['str',"'../db'"],['pn',';']],
    [],
    [['cm','// Rotate refresh tokens on each use (RFC 6749 §10.4)']],
    [['kw','export async function'],['',' '],['fn','refreshSession'],['pn','('],['','sessionId'],['pn',':'],['',' '],['kw','string'],['pn',')'],['',' { ']],
    [['','  '],['kw','const'],['',' session = '],['kw','await'],['',' '],['fn','db.sessions.findUnique'],['pn','('],['',' { where: { id: sessionId } } '],['pn',');']],
    [['','  '],['kw','if'],['',' ('],['','!session || session.revokedAt'],['pn',')'],['',' '],['kw','throw new'],['',' '],['fn','Error'],['pn','('],['str',"'invalid_grant'"],['pn',');']],
    [],
    [['','  '],['kw','const'],['',' { payload } = '],['kw','await'],['',' '],['fn','jwtVerify'],['pn','('],['','session.refresh, SECRET'],['pn',');']],
    [['','  '],['kw','const'],['',' next = '],['kw','await new'],['',' '],['fn','SignJWT'],['pn','('],['','{ sub: payload.sub }'],['pn',')']],
    [['','    .'],['fn','setProtectedHeader'],['pn','('],['',' { alg: '],['str',"'HS256'"],['',' } '],['pn',')']],
    [['','    .'],['fn','setExpirationTime'],['pn','('],['str',"'15m'"],['pn',')']],
    [['','    .'],['fn','sign'],['pn','('],['','SECRET'],['pn',');']],
    [],
    [['','  '],['kw','await'],['',' '],['fn','db.sessions.update'],['pn','('],['',' {']],
    [['','    where: { id: sessionId },']],
    [['','    data: { refresh: next, rotatedAt: '],['kw','new'],['',' '],['fn','Date'],['pn','('],['pn',')'],['',' }']],
    [['','  } '],['pn',');']],
    [],
    [['','  '],['kw','return'],['',' { access: next, expiresIn: '],['num','900'],['',' };']],
    [['pn','}']],
  ];

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">devsync-core</h1>
        <span className="page__subtitle">main · 4,217 commits</span>
        <div className="page__actions">
          <Button variant="ghost" size="sm" icon="git-branch">main</Button>
          <Button variant="secondary" size="sm" icon="git-pull-request">Open PR</Button>
          <Button variant="secondary" size="sm" icon="terminal">Clone</Button>
          <Button variant="primary" size="sm" icon="plus">New file</Button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px', fontSize: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ds-fg-2)' }}>
          <Avatar name="Jiwon Chen" size={18} style={{ borderColor: 'transparent' }} />
          chen.j
        </span>
        <span className="muted">·</span>
        <span style={{ color: 'var(--ds-fg-1)' }}>Rotate refresh tokens on every refresh</span>
        <span className="muted mono" style={{ marginLeft: 'auto' }}>a3f9c12 · 2m ago</span>
      </div>

      <div className="repo">
        <div className="repo__tree">
          {tree.map(it => (
            <div key={it.name}
              className={'repo__tree__item' + (it.name === active ? ' repo__tree__item--active' : '')}
              style={{ paddingLeft: 8 + it.depth * 14 }}
              onClick={() => it.type === 'file' && setActive(it.name)}>
              {it.type === 'folder'
                ? <><Icon name="chevron-right" size={10} style={{ transform: it.open ? 'rotate(90deg)' : 'none', color: 'var(--ds-fg-3)' }} /><Icon name="folder" size={12} style={{ color: 'var(--ds-fg-3)' }} /></>
                : <><span style={{ width: 10 }} /><Icon name={it.name.endsWith('.ts') || it.name.endsWith('.json') ? 'file-code' : 'file'} size={12} style={{ color: 'var(--ds-fg-3)' }} /></>
              }
              <span>{it.name.split('/').pop()}</span>
            </div>
          ))}
        </div>

        <div className="repo__file">
          <div className="repo__file__header">
            <Icon name="file-code" size={14} style={{ color: 'var(--ds-fg-3)' }} />
            <span className="repo__file__path">{active}</span>
            <span className="muted">·</span>
            <span className="muted">{code.length} lines · 642 B</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="tb__icon-btn"><Icon name="eye" size={13} /></button>
              <button className="tb__icon-btn"><Icon name="git-commit" size={13} /></button>
              <button className="tb__icon-btn"><Icon name="more-horizontal" size={13} /></button>
            </div>
          </div>
          <div className="repo__file__body">
            <div className="repo__file__gutter">
              {code.map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            <pre className="repo__file__code">
              {code.map((line, i) => (
                <div key={i}>
                  {line.length === 0 ? '\u00A0' : line.map(([cls, txt], j) => (
                    <span key={j} className={cls ? 'tk-' + cls : ''}>{txt}</span>
                  ))}
                </div>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
window.Repo = Repo;
