import type { Order } from '../lib/geometry';
import type { Prefs } from '../types';

interface Props {
  query: string;
  onQuery: (v: string) => void;
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
}

const THEMES: Array<[Prefs['theme'], string]> = [
  ['wood', 'Library'],
  ['gallery', 'Gallery'],
  ['academia', 'Academia'],
];

const ORDERS: Array<[Order, string]> = [
  ['author', 'By author'],
  ['added', 'Recently added'],
  ['title', 'By title'],
  ['colour', 'By colour'],
  ['pages', 'By length'],
];

export function Controls({ query, onQuery, prefs, onPrefs }: Props) {
  return (
    <div className="controls">
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

      <div className="seg" role="group" aria-label="Theme">
        {THEMES.map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={prefs.theme === v}
            onClick={() => onPrefs({ theme: v })}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
