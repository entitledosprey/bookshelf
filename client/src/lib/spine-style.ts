import type { Book } from '../types';

/**
 * Spine anatomy, after the way publishers actually set them.
 *
 * The previous version drew a coloured rectangle with the title down the middle,
 * which is why it read as a web page rather than a shelf. A real spine is a
 * composed object: the title dominates the upper two thirds, the author sits
 * below it at a smaller size, and there is almost always an imprint mark at the
 * very foot. Rules, bands and plates divide those zones. Getting that anatomy
 * right matters far more than the wood behind it.
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

export type SpineLayout =
  | 'title-author-imprint'  // the common trade paperback
  | 'banded-head'           // colour band at the head carrying the series
  | 'foil-rules'            // centred serif title between two rules
  | 'allcaps-block'         // heavy caps, modern nonfiction
  | 'plate'                 // light panel with dark type, Penguin-ish
  | 'two-field'             // the spine split into two colour fields
  | 'cloth-gilt'            // cloth binding, gilt lettering and rules
  | 'modern-sans';          // title at the head, author at the foot

const LAYOUTS: SpineLayout[] = [
  'title-author-imprint', 'banded-head', 'foil-rules', 'allcaps-block',
  'plate', 'two-field', 'cloth-gilt', 'modern-sans',
];

/** Imprint marks at the foot: the detail that most says "a publisher made this". */
export type Imprint = 'square' | 'circle' | 'penguin' | 'rule' | 'diamond' | 'none';
const IMPRINTS: Imprint[] = ['square', 'circle', 'penguin', 'rule', 'diamond', 'none'];

export interface Presentation {
  layout: SpineLayout;
  imprint: Imprint;
  /** Top-to-bottom is the US/UK convention; a seeded minority read upward. */
  updown: 'down' | 'up';
  /** Fraction of spine height the title block may occupy. */
  titleSpan: number;
  showAuthor: boolean;
  /** Dark ink on a light plate, or light ink on a dark one. */
  plateInk: string;
  lean: number | null;
}

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * Hardcovers skew toward cloth and foil; paperbacks toward plates and bands,
 * so the binding visibly influences the design rather than only the geometry.
 */
export function presentation(
  book: Book,
  opts: { heightPx: number; leaning?: boolean },
): Presentation {
  const r = rng(book.seed || 1);
  const hard = book.binding === 'hardcover' || book.binding === 'oversize';

  const weights: Array<[SpineLayout, number]> = hard
    ? [['cloth-gilt', .24], ['foil-rules', .2], ['title-author-imprint', .18],
       ['allcaps-block', .12], ['banded-head', .1], ['modern-sans', .08],
       ['two-field', .05], ['plate', .03]]
    : [['title-author-imprint', .24], ['plate', .17], ['banded-head', .15],
       ['modern-sans', .13], ['allcaps-block', .12], ['foil-rules', .08],
       ['two-field', .07], ['cloth-gilt', .04]];

  const roll = r();
  let acc = 0;
  let layout: SpineLayout = LAYOUTS[0];
  for (const [name, w] of weights) { acc += w; if (roll < acc) { layout = name; break; } }

  // A thin spine has no room for an imprint mark; a wide one nearly always has.
  const imprint = book.geometry.thicknessMm < 14
    ? 'none'
    : IMPRINTS[Math.floor(r() * IMPRINTS.length)];

  const titleSpan = layout === 'plate' ? 0.56
    : layout === 'two-field' ? 0.58
    : layout === 'banded-head' ? 0.62
    : layout === 'foil-rules' ? 0.66
    : 0.68;

  const leanRoll = r();
  return {
    layout,
    imprint,
    updown: r() < 0.18 ? 'up' : 'down',
    titleSpan,
    showAuthor: opts.heightPx > 120,
    plateInk: luminance(book.palette!.accent) > 0.45 ? '#17130e' : '#f6f1e7',
    lean: opts.leaning ? 3 + leanRoll * 4 : null,
  };
}

/**
 * Pick the longest title that fits. Truncation is semantic before it is
 * typographic: drop the series, then the subtitle, and only then ellipsize.
 */
export function fitTitle(book: Book, heightPx: number, span: number): string {
  const budget = Math.floor((heightPx * span) / 6.4);
  if (book.displayTitle.length <= budget) return book.displayTitle;
  return book.shortTitle;
}

/** Surname only when the foot is tight. */
export function fitAuthor(book: Book, heightPx: number): string {
  const budget = Math.floor((heightPx * 0.22) / 5.6);
  if (!book.author) return '';
  if (book.author.length <= budget) return book.author;
  const surname = book.authorSort.split(',')[0];
  return surname.length <= budget ? surname : '';
}
