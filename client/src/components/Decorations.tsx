import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Decoration } from '../types';

/** A framed photograph standing on a shelf, among the books. */
export function ShelfObject({ item, scale, onOpen }: {
  item: Decoration;
  scale: number;
  onOpen?: (item: Decoration) => void;
}) {
  const h = Math.round(item.heightMm * 0.65 * scale);
  const w = Math.round(item.widthMm * 0.65 * scale);
  return (
    <button
      type="button"
      className={`shelf-object so-${item.kind}`}
      style={{ '--ow': `${w}px`, '--oh': `${h}px` } as React.CSSProperties}
      aria-label={item.caption || 'A framed photograph on the shelf'}
      title={item.caption}
      onClick={() => onOpen?.(item)}
    >
      {item.hasImage
        ? <img src={item.imageUrl} alt={item.caption || ''} loading="lazy" decoding="async" />
        : <span className="so-blank" aria-hidden="true" />}
      {item.caption && <span className="so-caption">{item.caption}</span>}
    </button>
  );
}

/**
 * Adding and arranging the things that are not books.
 *
 * Kept deliberately small: pick a picture, say which shelf it stands on, nudge
 * it along. Anything more elaborate would be a layout editor, and this is meant
 * to take thirty seconds.
 */
export function DecorationManager({ items, shelfCount, onChanged, onClose }: {
  items: Decoration[];
  shelfCount: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [caption, setCaption] = useState('');
  const [shelfIndex, setShelfIndex] = useState(0);

  const addFile = async (file: File) => {
    setBusy(true); setErr('');
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('That picture is larger than 4 MB.');
      const image = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('That file could not be read.'));
        r.readAsDataURL(file);
      });
      await api.decorations.add({ kind: 'frame', caption, shelfIndex, position: 0.5, image });
      setCaption('');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'That did not work.'); }
  };

  return (
    <div className="look">
      <div className="look-group grow">
        <h3>Things on the shelves</h3>
        {err && <p className="error">{err}</p>}

        <div className="row">
          <input
            className="field"
            value={caption}
            placeholder="A caption, if you like"
            aria-label="Caption"
            onChange={(e) => setCaption(e.target.value)}
          />
          <label className="field shelf-picker">
            Shelf
            <select value={shelfIndex} onChange={(e) => setShelfIndex(Number(e.target.value))}>
              {Array.from({ length: Math.max(1, shelfCount) }, (_, i) => (
                <option key={i} value={i}>{i + 1}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={busy}
                  onClick={() => fileRef.current?.click()}>
            {busy ? 'Adding' : 'Add a picture'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void addFile(f); }}
          />
        </div>

        {items.length > 0 && (
          <ul className="object-list">
            {items.map((d) => (
              <li key={d.id}>
                {d.hasImage && <img src={d.imageUrl} alt="" />}
                <span className="grow">{d.caption || 'Untitled'}</span>
                <label>
                  Shelf
                  <select
                    value={d.shelfIndex}
                    onChange={(e) => act(() => api.decorations.move(d.id, { shelfIndex: Number(e.target.value) }))}
                  >
                    {Array.from({ length: Math.max(1, shelfCount) }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>
                </label>
                <input
                  type="range" min={0} max={1} step={0.05} value={d.position}
                  aria-label="Position along the shelf"
                  onChange={(e) => act(() => api.decorations.move(d.id, { position: Number(e.target.value) }))}
                />
                <button type="button" className="btn btn-ghost danger"
                        onClick={() => act(() => api.decorations.remove(d.id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <button type="button" className="btn btn-ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
