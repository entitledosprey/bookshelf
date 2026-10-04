import type { Book } from '../types';

/**
 * Millimetres to pixels.
 *
 * A 235mm hardcover is ~153px tall at scale 1, which fits a phone comfortably
 * and leaves room for several shelves on screen. Scale is a user preference.
 */
export const PX_PER_MM = 0.65;

/**
 * Thin books keep their true width down to this floor. Only the slimmest books
 * are affected, and the padded hit area in spines.css (max(100%, 44px)) makes
 * them tappable without inflating the visual width -- which would throw away
 * the proportional accuracy that is the point of the product.
 */
export const MIN_VISUAL_WIDTH_PX = 11;

export interface Dim {
  width: number;
  height: number;
  clamped: boolean;
}

export function spineDims(book: Book, scale: number): Dim {
  const raw = book.geometry.thicknessMm * PX_PER_MM * scale;
  const width = Math.max(MIN_VISUAL_WIDTH_PX, Math.round(raw));
  return {
    width,
    height: Math.round(book.geometry.heightMm * PX_PER_MM * scale),
    clamped: raw < MIN_VISUAL_WIDTH_PX,
  };
}

/* ── Arrangement ─────────────────────────────────────────────────────────── */

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Hue of the spine colour, for the rainbow arrangement. */
function hueOf(hex: string): number {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1; // greys sort to the front as a neutral band
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h * 360;
}

export type Order = 'author' | 'added' | 'title' | 'colour' | 'pages';

export function arrange(books: Book[], order: Order): Book[] {
  const out = [...books];
  switch (order) {
    case 'author':
      // Surname, then series, then position within the series, then title --
      // how a real shelf is organised, so an author reads as one block.
      return out.sort((a, b) =>
        collator.compare(a.authorSort, b.authorSort) ||
        collator.compare(a.series ?? '', b.series ?? '') ||
        (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0) ||
        collator.compare(a.displayTitle, b.displayTitle));
    case 'added':
      return out.sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''));
    case 'title':
      return out.sort((a, b) => collator.compare(a.displayTitle, b.displayTitle));
    case 'colour':
      return out.sort((a, b) =>
        hueOf(a.palette!.bg) - hueOf(b.palette!.bg) ||
        collator.compare(a.authorSort, b.authorSort));
    case 'pages':
      return out.sort((a, b) => (b.pages ?? 0) - (a.pages ?? 0));
    default:
      return out;
  }
}

/** Greedy fill: break to a new board when the row would overflow. */
export function packShelves(books: Book[], boardWidth: number, scale: number): Book[][] {
  // Floor, never round: a row that is one pixel too wide scrolls the page.
  const gap = 2;
  const rows: Book[][] = [];
  let row: Book[] = [];
  let used = 0;
  for (const b of books) {
    const w = spineDims(b, scale).width + gap;
    if (used + w > boardWidth && row.length) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(b);
    used += w;
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Tallest book in a row, so the shelf can reserve its height up front. */
export const rowHeight = (row: Book[], scale: number) =>
  row.reduce((m, b) => Math.max(m, spineDims(b, scale).height), 0);
