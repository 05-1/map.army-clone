import type { ReactNode } from 'react';

const PATHS: Record<string, string> = {
  select: 'M5 3l14 8-6 2 4 7-3 1.5-4-7-5 4z',
  symbol: 'M3 6h18v12H3zM3 6l18 12M21 6L3 18',
  asset: 'M12 2l2.5 7H21l-4 4.5 1.5 8.5-6.5-4-6.5 4L7 13.5 3 9h6.500z',
  text: 'M5 5h14M12 5v14M9 19h6',
  line: 'M4 19L20 5',
  arrow: 'M4 19L19 6M11 5.500h8.500V14',
  polygon: 'M12 3l8 6-3 10H7L4 9z',
  circle: 'M12 3a9 9 0 100 18 9 9 0 000-18z',
  freehand: 'M3 16c3-9 6 3 9-4s5-6 9-2',
  undo: 'M9 7L4 12l5 5M4 12h10a6 6 0 010 12',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 000 12',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.500 6.200A9.500 9.500 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.600M6.500 7.500A17 17 0 002 12s4 6 10 6a9.500 9.500 0 003.500-.700',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 017.500-2',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  share: 'M16 6l-4-4-4 4M12 2v13M5 12v8h14v-8',
  magnet: 'M6 3v9a6 6 0 0012 0V3h-4v9a2 2 0 01-4 0V3zM6 7h4M14 7h4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  x: 'M6 6l12 12M18 6L6 18',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function IconButton(p: { icon: string; title: string; onClick: () => void; active?: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      className={`ib${p.active ? ' on' : ''}${p.danger ? ' danger' : ''}`}
      title={p.title}
      aria-label={p.title}
      aria-pressed={p.active}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <Icon name={p.icon} />
    </button>
  );
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

export const SWATCHES = ['#ff453a', '#0a84ff', '#30d158', '#ffd60a', '#ff9f0a', '#bf5af2', '#64d2ff', '#ffffff', '#111111'];

export function ColorPicker({ value, onChange, onFocus }: { value: string; onChange: (c: string) => void; onFocus?: () => void }) {
  return (
    <div className="colors">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={`sw${c === value ? ' on' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={`Color ${c}`}
          onClick={() => {
            onFocus?.();
            onChange(c);
          }}
        />
      ))}
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onFocus={onFocus} onChange={(e) => onChange(e.target.value)} title="Custom color" />
    </div>
  );
}
