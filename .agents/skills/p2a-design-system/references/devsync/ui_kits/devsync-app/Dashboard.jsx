// Dashboard.jsx — overview with stat cards, area chart, activity feed
// Uses hand-rolled SVG charts (no chart library dependency).

function Sparkline({ data, width = 110, height = 28, color = 'var(--ds-accent-1)' }) {
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / range) * (height - 4) - 2]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fillD = d + ` L${width} ${height} L0 ${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <path d={fillD} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function AreaChart({ series, width = 720, height = 220, color = 'var(--ds-accent-1)' }) {
  const padding = { top: 16, right: 16, bottom: 24, left: 36 };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  const max = Math.max(...series.map(p => p.v));
  const xs = w / (series.length - 1);
  const pts = series.map((p, i) => [i * xs, h - (p.v / max) * h]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fillD = d + ` L${w} ${h} L0 ${h} Z`;
  const yTicks = 4;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <g transform={`translate(${padding.left} ${padding.top})`}>
        <g className="chart-grid">
          {Array.from({ length: yTicks + 1 }).map((_, i) => (
            <line key={i} x1="0" x2={w} y1={(h / yTicks) * i} y2={(h / yTicks) * i} strokeDasharray={i === yTicks ? '0' : '2 3'} />
          ))}
        </g>
        <g className="chart-axis">
          {Array.from({ length: yTicks + 1 }).map((_, i) => {
            const v = Math.round((max / yTicks) * (yTicks - i));
            return <text key={i} x={-8} y={(h / yTicks) * i + 4} textAnchor="end">{v}</text>;
          })}
          {series.map((p, idx) => idx % Math.ceil(series.length / 8) === 0 && (
            <text key={idx} x={idx * xs} y={h + 14} textAnchor="middle">{p.t}</text>
          ))}
        </g>
        <path d={fillD} className="chart-area" />
        <path d={d} className="chart-line" />
        {pts.map(([x, y], i) => i % 4 === 0 && (
          <circle key={i} cx={x} cy={y} r="2.5" className="chart-dot" />
        ))}
      </g>
    </svg>
  );
}

function BarBreakdown({ items }) {
  const total = items.reduce((s, it) => s + it.v, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--ds-bg-3)' }}>
        {items.map(it => (
          <div key={it.k} style={{ flex: it.v, background: it.color }} title={`${it.k} · ${it.v}`} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(it => (
          <div key={it.k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color }} />
            <span style={{ color: 'var(--ds-fg-2)' }}>{it.k}</span>
            <span className="mono" style={{ marginLeft: 'auto', color: 'var(--ds-fg-3)' }}>{Math.round((it.v / total) * 100)}%</span>
            <span className="mono" style={{ color: 'var(--ds-fg-1)', minWidth: 28, textAlign: 'right' }}>{it.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard() {
  const stats = [
    { label: 'Open issues',     value: '247', delta: '+12',  up: false, spark: [12, 14, 13, 17, 18, 22, 21, 19, 23, 22, 25, 28, 27] },
    { label: 'PRs in review',   value: '12',  delta: '−3',   up: true,  spark: [22, 19, 17, 18, 16, 14, 15, 13, 11, 13, 12, 10, 12] },
    { label: 'CI pass rate',    value: '94.2%', delta: '+1.4%', up: true, spark: [91, 92, 89, 90, 92, 93, 93, 92, 94, 94, 95, 94, 94] },
    { label: 'Avg merge time',  value: '6.4h', delta: '−0.8h', up: true, spark: [9, 8.5, 8, 7.8, 7.6, 7.4, 7, 6.8, 6.6, 6.4, 6.3, 6.4, 6.4] },
  ];

  const series = [
    { t: 'Apr 1', v: 18 }, { t: '5', v: 22 }, { t: '10', v: 19 }, { t: '15', v: 27 },
    { t: '20', v: 31 }, { t: '25', v: 28 }, { t: '30', v: 34 }, { t: 'May 5', v: 38 },
    { t: '10', v: 35 }, { t: '15', v: 42 }, { t: '20', v: 39 }, { t: '25', v: 47 },
    { t: '30', v: 44 },
  ];

  const breakdown = [
    { k: 'Frontend',       v: 84, color: 'var(--ds-chart-1)' },
    { k: 'Backend',        v: 71, color: 'var(--ds-chart-2)' },
    { k: 'Infrastructure', v: 38, color: 'var(--ds-chart-3)' },
    { k: 'Mobile',         v: 29, color: 'var(--ds-chart-4)' },
    { k: 'Docs',           v: 17, color: 'var(--ds-chart-5)' },
  ];

  const activity = [
    { icon: 'git-merge',       who: 'chen.j',  what: 'merged', target: 'feat/auth-token-refresh', meta: '→ main', time: '2m' },
    { icon: 'circle-x',        who: 'CI',      what: 'failed', target: 'web-e2e · macos-14',      meta: 'after 4m 12s', time: '7m', tone: 'danger' },
    { icon: 'git-pull-request',who: 'kim.s',   what: 'opened PR', target: '#1284 Refactor session middleware', meta: '+312 −89', time: '17m' },
    { icon: 'message-square',  who: 'park.h',  what: 'commented on', target: '#1280 SSO logout returns 500', meta: '"reproduced on stage-7"', time: '34m' },
    { icon: 'git-commit',      who: 'lee.l',   what: 'pushed', target: '4 commits', meta: 'to fix/oauth-state', time: '1h' },
    { icon: 'circle-check',    who: 'CI',      what: 'passed', target: 'api-unit · linux-22.04',  meta: 'in 1m 47s', time: '1h', tone: 'success' },
  ];

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Dashboard</h1>
        <span className="page__subtitle">last 30 days</span>
        <div className="page__actions">
          <Button variant="ghost" icon="filter" size="sm">Filters</Button>
          <Button variant="secondary" icon="calendar" size="sm">Apr 28 – May 28</Button>
          <Button variant="primary" icon="plus" size="sm">New issue</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {stats.map(s => (
          <div className="stat" key={s.label}>
            <div className="stat__label">{s.label}</div>
            <div className="stat__row">
              <div className="stat__value">{s.value}</div>
              <span className={'stat__delta ' + (s.up ? 'stat__delta--up' : 'stat__delta--down')}>
                <Icon name={s.up ? 'arrow-down' : 'arrow-up'} size={11} />
                {s.delta}
              </span>
            </div>
            <Sparkline data={s.spark} width={220} height={28} />
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div className="card">
          <div className="card__header">
            <div className="card__title">Issues opened</div>
            <span className="muted mono" style={{ fontSize: 11 }}>cumulative · daily</span>
            <div style={{ marginLeft: 'auto', display: 'inline-flex', padding: 2, background: 'var(--ds-bg-3)', borderRadius: 'var(--ds-radius-sm)', border: '1px solid var(--ds-border-1)' }}>
              {['1W', '1M', '3M', 'YTD'].map((t, i) => (
                <button key={t} style={{
                  height: 20, padding: '0 8px',
                  background: i === 1 ? 'var(--ds-bg-1)' : 'transparent',
                  border: i === 1 ? '1px solid var(--ds-border-2)' : '1px solid transparent',
                  borderRadius: 3, color: i === 1 ? 'var(--ds-fg-1)' : 'var(--ds-fg-3)',
                  fontFamily: 'var(--ds-font-mono)', fontSize: 10, cursor: 'pointer',
                }}>{t}</button>
              ))}
            </div>
          </div>
          <div className="card__body" style={{ padding: 8 }}>
            <AreaChart series={series} />
          </div>
        </div>

        <div className="card">
          <div className="card__header">
            <div className="card__title">By area</div>
            <span className="muted mono" style={{ fontSize: 11, marginLeft: 'auto' }}>239 issues</span>
          </div>
          <div className="card__body">
            <BarBreakdown items={breakdown} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__header">
          <div className="card__title">Activity</div>
          <span className="muted mono" style={{ fontSize: 11 }}>real-time</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--ds-success-1)' }} />
            <span className="muted" style={{ fontSize: 11 }}>Live</span>
          </div>
        </div>
        <div className="feed">
          {activity.map((a, i) => (
            <div className="feed__item" key={i}>
              <span className="feed__icon" style={{ color: a.tone ? `var(--ds-${a.tone}-1)` : 'var(--ds-fg-3)', borderColor: a.tone ? `var(--ds-${a.tone}-border)` : 'var(--ds-border-1)' }}>
                <Icon name={a.icon} size={12} />
              </span>
              <div className="feed__body">
                <b>{a.who}</b>{' '}{a.what}{' '}<span className="mono" style={{ color: 'var(--ds-fg-1)' }}>{a.target}</span>{' '}<span className="muted">{a.meta}</span>
              </div>
              <span className="feed__time">{a.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
