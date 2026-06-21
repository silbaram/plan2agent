// primitives.jsx — shared atoms: Icon, Button, Badge, Avatar
// Loaded as global Babel-transpiled script — exports onto window at the bottom.

// --- Icon ---------------------------------------------------------------
// Minimal Lucide-style icon set. Strokes inherit currentColor.
const ICONS = {
  'layout-dashboard': 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  'list-checks': 'M3 17l2 2 4-4 M3 7l2 2 4-4 M13 6h8 M13 12h8 M13 18h8',
  'kanban': 'M6 5v11 M12 5v6 M18 5v14 M5 4h2v12H5z M11 4h2v8h-2z M17 4h2v15h-2z',
  'git-branch': 'M6 3v12 M18 9a3 3 0 100-6 3 3 0 000 6z M6 18a3 3 0 100-6 3 3 0 000 6z M6 21v0 M18 12v3a3 3 0 01-3 3H9',
  'folder': 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  'file': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  'file-code': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M10 13l-2 2 2 2 M14 13l2 2-2 2',
  'settings': 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  'search': 'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35',
  'bell': 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
  'plus': 'M12 5v14 M5 12h14',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  'arrow-up': 'M12 19V5 M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14 M5 12l7 7 7-7',
  'check': 'M5 12l5 5L20 7',
  'x': 'M6 18L18 6 M6 6l12 12',
  'filter': 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  'sort': 'M7 4v16 M3 8l4-4 4 4 M17 20V4 M21 16l-4 4-4-4',
  'more-horizontal': 'M12 13a1 1 0 100-2 1 1 0 000 2z M19 13a1 1 0 100-2 1 1 0 000 2z M5 13a1 1 0 100-2 1 1 0 000 2z',
  'sun': 'M12 17a5 5 0 100-10 5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  'moon': 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  'circle-dot': 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 14a2 2 0 100-4 2 2 0 000 4z',
  'circle-check': 'M12 22a10 10 0 100-20 10 10 0 000 20z M9 12l2 2 4-4',
  'circle-x': 'M12 22a10 10 0 100-20 10 10 0 000 20z M15 9l-6 6 M9 9l6 6',
  'alert-triangle': 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
  'play': 'M5 3l14 9-14 9V3z',
  'pause': 'M6 4h4v16H6z M14 4h4v16h-4z',
  'message-square': 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  'git-pull-request': 'M18 18a3 3 0 100-6 3 3 0 000 6z M6 18a3 3 0 100-6 3 3 0 000 6z M6 9a3 3 0 100-6 3 3 0 000 6z M6 9v6 M18 12V8a4 4 0 00-4-4h-2',
  'git-commit': 'M12 15a3 3 0 100-6 3 3 0 000 6z M3 12h6 M15 12h6',
  'git-merge': 'M6 21a3 3 0 100-6 3 3 0 000 6z M18 9a3 3 0 100-6 3 3 0 000 6z M6 15V6 M18 9a9 9 0 01-9 9',
  'users': 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  'star': 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  'eye': 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 100-6 3 3 0 000 6z',
  'lock': 'M5 11h14v10H5z M8 11V7a4 4 0 018 0v4',
  'help-circle': 'M12 22a10 10 0 100-20 10 10 0 000 20z M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3 M12 17h.01',
  'inbox': 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z',
  'calendar': 'M3 6a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2z M16 2v4 M8 2v4 M3 10h18',
  'terminal': 'M4 17l6-6-6-6 M12 19h8',
  'database': 'M12 8a9 3 0 100-6 9 3 0 000 6z M21 12c0 1.66-4 3-9 3s-9-1.34-9-3 M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  'zap': 'M13 2L3 14h9l-1 8 10-12h-9z',
};
function Icon({ name, size = 16, stroke = 1.75, style }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}>
      {d.split(' M').map((seg, i) => (
        <path key={i} d={(i === 0 ? '' : 'M') + seg} />
      ))}
    </svg>
  );
}

// --- Button -------------------------------------------------------------
function Button({ variant = 'secondary', size, icon, iconRight, children, onClick, className = '', style }) {
  const cn = `btn btn--${variant} ${size === 'sm' ? 'btn--sm' : ''} ${!children && icon ? 'btn--icon' : ''} ${className}`.trim();
  return (
    <button className={cn} onClick={onClick} style={style}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
    </button>
  );
}

// --- Badge --------------------------------------------------------------
function Badge({ tone = 'neutral', dot, children, className = '' }) {
  return (
    <span className={`badge badge--${tone} ${className}`}>
      {dot && <span className="badge__dot" style={{ background: `var(--ds-${tone}-1)` }} />}
      {children}
    </span>
  );
}

function Tag({ children }) {
  return <span className="badge badge--tag">{children}</span>;
}

// --- Avatar -------------------------------------------------------------
const AVATAR_COLORS = ['#3B6FF6', '#14B8A6', '#8B5CF6', '#F97316', '#EC4899', '#22C55E', '#EAB308'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function Avatar({ name, size = 24, style }) {
  const initials = name.split(/[\s.]+/).slice(0, 2).map(s => s[0]?.toUpperCase()).join('');
  return (
    <span className="avatar" title={name}
      style={{ background: avatarColor(name), width: size, height: size, fontSize: size <= 22 ? 9 : 10, ...style }}>
      {initials}
    </span>
  );
}
function AvatarStack({ names, max = 3, size = 22 }) {
  const shown = names.slice(0, max);
  const overflow = names.length - max;
  return (
    <span className="avatar-stack">
      {shown.map(n => <Avatar key={n} name={n} size={size} />)}
      {overflow > 0 && (
        <span className="avatar" style={{ background: 'var(--ds-bg-3)', color: 'var(--ds-fg-2)', width: size, height: size, fontSize: 9 }}>
          +{overflow}
        </span>
      )}
    </span>
  );
}

// --- Status pill (used in tables) ---------------------------------------
const STATUS_MAP = {
  'open':       { tone: 'success', label: 'Open' },
  'in-review':  { tone: 'info',    label: 'In review' },
  'blocked':    { tone: 'warning', label: 'Blocked' },
  'closed':     { tone: 'neutral', label: 'Closed' },
  'failed':     { tone: 'danger',  label: 'Failed' },
  'merged':     { tone: 'info',    label: 'Merged' },
  'draft':      { tone: 'neutral', label: 'Draft' },
  'passed':     { tone: 'success', label: 'Passed' },
  'in-progress':{ tone: 'info',    label: 'In progress' },
  'done':       { tone: 'success', label: 'Done' },
  'backlog':    { tone: 'neutral', label: 'Backlog' },
};
function Status({ value }) {
  const s = STATUS_MAP[value] || { tone: 'neutral', label: value };
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

// --- Tooltip ------------------------------------------------------------
// Hover wrapper. Opaque dark bubble, optional shortcut chip.
function Tooltip({ label, hint, children, side = 'top' }) {
  const [show, setShow] = React.useState(false);
  const timer = React.useRef(null);
  const enter = () => { timer.current = setTimeout(() => setShow(true), 400); };
  const leave = () => { clearTimeout(timer.current); setShow(false); };
  const pos = side === 'top'
    ? { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }
    : { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' };
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {show && (
        <span style={{
          position: 'absolute', zIndex: 60, ...pos,
          display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
          background: 'var(--slate-900)', border: '1px solid var(--ds-border-2)',
          color: '#F8FAFC', fontSize: 11, padding: '5px 8px',
          borderRadius: 'var(--ds-radius-sm)', boxShadow: 'var(--ds-shadow-md)',
          pointerEvents: 'none',
        }}>
          {label}
          {hint && <span className="tb__kbd" style={{ background: 'var(--slate-800)', borderColor: 'var(--slate-700)', color: '#CBD5E1' }}>{hint}</span>}
        </span>
      )}
    </span>
  );
}

// --- Menu (dropdown / context) ------------------------------------------
// Controlled open. Anchor with position:relative around <Menu>.
function Menu({ open, items, onClose, style }) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div role="menu" style={{
        position: 'absolute', zIndex: 41, minWidth: 200,
        background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border-2)',
        borderRadius: 'var(--ds-radius-md)', boxShadow: 'var(--ds-shadow-lg)',
        padding: 4, ...style,
      }}>
        {items.map((it, i) => it.divider ? (
          <div key={i} style={{ height: 1, background: 'var(--ds-border-1)', margin: '4px 6px' }} />
        ) : (
          <div key={i} role="menuitem"
            onClick={() => { it.onClick && it.onClick(); onClose && onClose(); }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--ds-bg-3)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 10px',
              borderRadius: 'var(--ds-radius-sm)', cursor: 'pointer', fontSize: 13,
              color: it.danger ? 'var(--ds-danger-fg)' : 'var(--ds-fg-1)',
            }}>
            {it.icon && <Icon name={it.icon} size={15} style={{ color: it.danger ? 'var(--ds-danger-1)' : 'var(--ds-fg-3)' }} />}
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.hint && <span className="tb__kbd">{it.hint}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

// --- Alert (inline) -----------------------------------------------------
const ALERT_ICON = { success: 'circle-check', warning: 'alert-triangle', danger: 'circle-x', info: 'help-circle' };
function Alert({ tone = 'info', title, children }) {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '10px 12px',
      background: `var(--ds-${tone}-bg)`, border: `1px solid var(--ds-${tone}-border)`,
      borderRadius: 'var(--ds-radius-md)',
    }}>
      <Icon name={ALERT_ICON[tone]} size={16} style={{ color: `var(--ds-${tone}-1)`, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontSize: 13, fontWeight: 600, color: `var(--ds-${tone}-fg)`, lineHeight: 1.3 }}>{title}</div>}
        {children && <div style={{ fontSize: 12, color: 'var(--ds-fg-2)', marginTop: title ? 2 : 0, lineHeight: 1.4 }}>{children}</div>}
      </div>
    </div>
  );
}

// --- Toast --------------------------------------------------------------
function Toast({ tone = 'success', children, action, onAction, onClose }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border-2)',
      borderRadius: 'var(--ds-radius-md)', boxShadow: 'var(--ds-shadow-lg)', minWidth: 280,
    }}>
      <Icon name={ALERT_ICON[tone]} size={16} style={{ color: `var(--ds-${tone}-1)`, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13, color: 'var(--ds-fg-1)' }}>{children}</span>
      {action && <button onClick={onAction} style={{ background: 'none', border: 'none', color: 'var(--ds-accent-1)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--ds-font-sans)' }}>{action}</button>}
      <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ds-fg-4)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}><Icon name="x" size={14} /></button>
    </div>
  );
}

// --- Modal --------------------------------------------------------------
function Modal({ open, onClose, icon, tone, title, children, actions }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(6,10,20,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 420, background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border-2)',
        borderRadius: 'var(--ds-radius-md)', boxShadow: 'var(--ds-shadow-lg)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 18px' }}>
          {icon && (
            <span style={{
              width: 32, height: 32, flexShrink: 0, borderRadius: 'var(--ds-radius-sm)',
              background: `var(--ds-${tone || 'info'}-bg)`, border: `1px solid var(--ds-${tone || 'info'}-border)`,
              color: `var(--ds-${tone || 'info'}-1)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}><Icon name={icon} size={16} /></span>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-fg-1)' }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--ds-fg-2)', marginTop: 4, lineHeight: 1.45 }}>{children}</div>
          </div>
        </div>
        {actions && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', background: 'var(--ds-bg-1)', borderTop: '1px solid var(--ds-border-1)' }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// --- EmptyState ---------------------------------------------------------
function EmptyState({ icon = 'inbox', title, children, actions }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', gap: 10, padding: 40,
    }}>
      <span style={{
        width: 36, height: 36, borderRadius: 999, background: 'var(--ds-bg-3)',
        border: '1px solid var(--ds-border-1)', color: 'var(--ds-fg-3)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon name={icon} size={18} /></span>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-fg-1)' }}>{title}</div>
      {children && <div style={{ fontSize: 12, color: 'var(--ds-fg-3)', maxWidth: 280, lineHeight: 1.45 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>{actions}</div>}
    </div>
  );
}

// --- Export -------------------------------------------------------------
Object.assign(window, {
  Icon, Button, Badge, Tag, Avatar, AvatarStack, Status, avatarColor,
  Tooltip, Menu, Alert, Toast, Modal, EmptyState,
});
