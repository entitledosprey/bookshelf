import { useState } from 'react';
import type { Order } from '../lib/geometry';
import type { Prefs, ShelfMaterial, Backdrop } from '../types';

interface Props {
  query: string;
  onQuery: (v: string) => void;
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  /** Only a signed-in reader has shelves of their own to decorate. */
  canDecorate: boolean;
  decorating: boolean;
  onDecorate: () => void;
}

const ORDERS: Array<[Order, string]> = [
  ['author', 'By author'],
  ['added', 'Recently added'],
  ['title', 'By title'],
  ['colour', 'By colour'],
  ['pages', 'By length'],
];

const SHELVES: Array<[ShelfMaterial, string]> = [
  ['pine', 'Pine'], ['oak', 'Oak'], ['walnut', 'Walnut'],
  ['white', 'White'], ['black', 'Black'],
];

const BACKDROPS: Array<[Backdrop, string]> = [
  ['foliage', 'Foliage'], ['plaster', 'Plaster'], ['walnut-panel', 'Panelling'],
  ['ink', 'Ink'], ['sunroom', 'Sunroom'],
];

export function Controls({ query, onQuery, prefs, onPrefs, canDecorate, decorating, onDecorate }: Props) {
  // The look controls are a drawer rather than a permanent bar: they are for
  // setting up once and then leaving alone, and the shelf should be what fills
  // the screen.
  const [open, setOpen] = useState(false);

  return (
    <div className="controls">
      <div className="controls-row">
        <input
          className="field"
          type="search"
          value={query}
          placeholder="Search your shelves"
          aria-label="Search your shelves"
          onChange={(e) => onQuery(e.target.value)}
        />

        <select
          className="field"
          value={prefs.order}
          aria-label="Shelf order"
          onChange={(e) => onPrefs({ order: e.target.value as Order })}
        >
          {ORDERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>

        <div className="seg" role="group" aria-label="Book size">
          {[1, 1.6, 2.4].map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={prefs.scale === s}
              aria-label={['Small books', 'Medium books', 'Large books'][i]}
              onClick={() => onPrefs({ scale: s })}
            >
              {['S', 'M', 'L'][i]}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Done' : 'Make it yours'}
        </button>

        {canDecorate && (
          <button type="button" className="btn btn-ghost" aria-expanded={decorating} onClick={onDecorate}>
            {decorating ? 'Done' : 'Add things'}
          </button>
        )}
      </div>

      {open && (
        <div className="look">
          <div className="look-group">
            <h3>Shelves</h3>
            <div className="swatches" role="group" aria-label="Shelf material">
              {SHELVES.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={`swatch sw-${v}`}
                  aria-pressed={prefs.shelf === v}
                  aria-label={label}
                  title={label}
                  onClick={() => onPrefs({ shelf: v })}
                />
              ))}
            </div>
          </div>

          <div className="look-group">
            <h3>Behind the books</h3>
            <div className="swatches" role="group" aria-label="Backdrop">
              {BACKDROPS.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={`swatch bd-${v}`}
                  aria-pressed={prefs.backdrop === v}
                  aria-label={label}
                  title={label}
                  onClick={() => onPrefs({ backdrop: v })}
                />
              ))}
            </div>
          </div>

          <div className="look-group">
            <h3>Arrangement</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.stacks}
                onChange={(e) => onPrefs({ stacks: e.target.checked })}
              />
              Lay some books flat in stacks
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
