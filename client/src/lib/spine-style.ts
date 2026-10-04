import type { Book } from '../types';

/**
 * Presentation choices the server seeded, expanded into CSS values.
 *
 * mulberry32 mirrors server/src/seed.js so a book's reading direction and lean
 * are stable across reloads, devices and client versions. The server owns the
 * spine STYLE choice; the client only derives the small continuous values that
 * depend on layout.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fraction of a spine's height each style leaves for lettering.
 *
 * Single source of truth: Spine.tsx sets it as --text-span, spines.css uses it
 * for BOTH the clip and the font-size, and fitTitle below uses it to pick the
 * title variant. A style that paints a plate or rules over part of the spine
 * must reserve that space here, or its type overruns the box it sits in.
 */
export const TEXT_SPAN: Record<string, number> = {
  'classic-serif-centred': 0.9,
  'allcaps-sans-top': 0.82,
  'stacked-slab': 0.9,
  'banded-plate': 0.58,   // the plate is inset 18% top and bottom
  'foil-rule': 0.74,      // rules sit at 9% and 91%
  'publisher-footer': 0.72,
  'two-tone-split': 0.6,  // the accent band covers the top third
  'cloth-stamped': 0.86,
};

export const spanFor = (style: string) => TEXT_SPAN[style] ?? 0.9;

export interface SpinePresentation {
  className: string;
  /** 'down' is the US/UK convention; a seeded ~20% read bottom-to-top. */
  updown: 'down' | 'up';
  /** Degrees, for the last books on a partly filled shelf. */
  lean: number | null;
  /** Dark text on a light accent plate, or light text on a dark one. */
  plateText: string;
  showAuthor: boolean;
  /** Fraction of the spine height available for type. */
  textSpan: number;
}

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function presentation(book: Book, opts: { leaning?: boolean; height: number } = { height: 0 }): SpinePresentation {
  const r = rng(book.seed || 1);
  const updown = r() < 0.2 ? 'up' : 'down';
  const leanRoll = r();
  const textSpan = spanFor(book.spineStyle);
  return {
    className: `s-${book.spineStyle}`,
    updown,
    // Always leans RIGHT, into the empty part of the shelf -- a book cannot
    // lean left against the ones holding it up. Kept shallow: past about 7
    // degrees it reads as falling over rather than resting.
    lean: opts.leaning ? 3 + leanRoll * 4 : null,
    plateText: luminance(book.palette!.accent) > 0.45 ? '#15110d' : '#f4efe6',
    // Only put the author on a spine with room for it, as a binder would.
    showAuthor: opts.height * textSpan > 150 && book.displayTitle.length < 46,
    textSpan,
  };
}

/**
 * Pick the longest title variant that will plausibly fit, so truncation is
 * SEMANTIC before it is typographic: drop the series, then the subtitle, and
 * only then let CSS ellipsize. "The Lord of the Rings: The Fellowship of the
 * Ring (The Lord of the Rings, #1)" becomes "The Fellowship of the Ring", never
 * "The Lord of the Ri...".
 */
export function fitTitle(book: Book, spineHeightPx: number, textSpan = 0.9): string {
  const perChar = 6.2;
  // Budget against the space the style actually leaves, not the whole spine.
  const budget = Math.floor((spineHeightPx * textSpan) / perChar);
  if (book.displayTitle.length <= budget) return book.displayTitle;
  if (book.shortTitle.length <= budget) return book.shortTitle;
  return book.shortTitle;
}

/** Surname only when a spine is tight. */
export function fitAuthor(book: Book, spineHeightPx: number, titleLen: number, textSpan = 0.9): string {
  const remaining = Math.floor((spineHeightPx * textSpan) / 6.2) - titleLen - 3;
  if (book.author.length <= remaining) return book.author;
  const surname = book.authorSort.split(',')[0];
  return surname.length <= remaining ? surname : '';
}
