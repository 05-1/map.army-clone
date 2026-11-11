import { useMemo, useState } from 'react';
import type { Feature } from '../lib/types';
import { useEd } from './store';
import { IconButton, Section } from './ui';

const KIND_LABEL: Record<Feature['kind'], string> = {
  symbol: 'Unit', asset: 'Graphic', text: 'Text', line: 'Line', arrow: 'Arrow', polygon: 'Polygon', circle: 'Circle', freehand: 'Freehand',
};

export function LayersPanel() {
  const layers = useEd((s) => s.layers);
  const features = useEd((s) => s.features);
  const active = useEd((s) => s.activeLayerId);
  const selection = useEd((s) => s.selection);
  const [renaming, setRenaming] = useState<string | null>(null);
  const st = useEd.getState;

  const sorted = useMemo(() => [...layers].sort((a, b) => b.z - a.z), [layers]); // top layer first
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of features) m.set(f.layer_id, (m.get(f.layer_id) ?? 0) + 1);
    return m;
  }, [features]);
  const objects = useMemo(() => features.filter((f) => f.layer_id === active).sort((a, b) => b.z - a.z), [features, active]);
  const sel = useMemo(() => new Set(selection), [selection]);

  const toggle = (id: string, key: 'visible' | 'locked', value: boolean) => {
    st().checkpoint();
    st().patchLayer(id, { [key]: value });
  };

  return (
    <>
      <Section title="Layers" action={<IconButton icon="plus" title="Add layer" onClick={() => st().addLayer()} />}>
        <ul className="layers">
          {sorted.map((l, i) => (
            <li key={l.id} className={l.id === active ? 'on' : ''} onClick={() => useEd.setState({ activeLayerId: l.id })}>
              <IconButton icon={l.visible ? 'eye' : 'eyeOff'} title={l.visible ? 'Hide (also hides it from viewers)' : 'Show'} onClick={() => toggle(l.id, 'visible', !l.visible)} />
              <IconButton icon={l.locked ? 'lock' : 'unlock'} title={l.locked ? 'Unlock' : 'Lock'} active={l.locked} onClick={() => toggle(l.id, 'locked', !l.locked)} />
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  maxLength={80}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== l.name) {
                      st().checkpoint();
                      st().patchLayer(l.id, { name });
                    }
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
                />
              ) : (
                <span className="name" onDoubleClick={() => setRenaming(l.id)} title="Double-click to rename">
                  {l.name}
                </span>
              )}
              <span className="count">{counts.get(l.id) ?? 0}</span>
              <IconButton icon="up" title="Move up" disabled={i === 0} onClick={() => st().moveLayer(l.id, 1)} />
              <IconButton icon="down" title="Move down" disabled={i === sorted.length - 1} onClick={() => st().moveLayer(l.id, -1)} />
              <IconButton
                icon="trash"
                title="Delete layer"
                danger
                onClick={() => {
                  const n = counts.get(l.id) ?? 0;
                  if (!n || confirm(`Delete "${l.name}" and its ${n} object${n === 1 ? '' : 's'}?`)) st().removeLayer(l.id);
                }}
              />
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Objects in layer">
        {objects.length === 0 ? (
          <p className="empty">Nothing here yet. Pick a tool and click the map.</p>
        ) : (
          <ul className="objects">
            {objects.map((f) => (
              <li
                key={f.id}
                className={sel.has(f.id) ? 'on' : ''}
                onClick={(e) => st().select(e.shiftKey ? (sel.has(f.id) ? selection.filter((x) => x !== f.id) : [...selection, f.id]) : [f.id])}
              >
                <span className="kind">{KIND_LABEL[f.kind]}</span>
                <span className="name">{f.props.name || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
