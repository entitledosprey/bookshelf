/**
 * The Bookshelf API contract.
 *
 * This file is the single source of truth for what /api/v1 returns. It is
 * imported by the web client and mirrored in prose in docs/API.md, which is
 * what a future SwiftUI client should be written against.
 *
 * Rule: the server never sends HTML or CSS. Geometry is millimetres, colour is
 * hex, presentation choices are seeds and enum names. Any client can render it.
 */

export type ExclusiveShelf = 'read' | 'currently-reading' | 'to-read';

export type Binding =
  | 'hardcover'
  | 'trade-paperback'
  | 'mass-market'
  | 'oversize'
  | 'ebook'
  | 'audiobook'
  | 'unknown';

/** Where a geometry figure came from. 'heuristic' is the common case. */
export type DimsSource = 'openlibrary' | 'googlebooks' | 'override' | 'heuristic';

export type PaletteSource = 'image' | 'grayscale-cloth' | 'hash' | 'override';

/** One of eight curated spine treatments, chosen deterministically from the seed. */
export type SpineStyle =
  | 'classic-serif-centred'
  | 'allcaps-sans-top'
  | 'stacked-slab'
  | 'banded-plate'
  | 'foil-rule'
  | 'publisher-footer'
  | 'two-tone-split'
  | 'cloth-stamped';

export interface Geometry {
  heightMm: number;
  widthMm: number;
  thicknessMm: number;
  source: DimsSource;
  /** 0..1. ~0.95 real dimensions, ~0.6 heuristic from a real page count, ~0.2 no page count. */
  confidence: number;
}

export interface Palette {
  /** Spine field colour. */
  bg: string;
  /** Foil / stamping / rules. */
  accent: string;
  /** Spine lettering. Guaranteed >= 4.5:1 contrast against bg. */
  fg: string;
  swatches: string[];
  isDark: boolean;
  isGrayscale: boolean;
  source: PaletteSource;
}

export interface Book {
  id: string;
  title: string;
  /** Title with the series parenthetical removed. What the spine typesets. */
  displayTitle: string;
  /** Title with the subtitle removed too. Used when the spine is very short. */
  shortTitle: string;
  series: string | null;
  seriesPosition: number | null;
  author: string;
  /** "Le Guin, Ursula K." — the default shelf ordering key. */
  authorSort: string;
  isbn: string | null;
  pages: number | null;
  published: number | null;
  averageRating: number | null;
  userRating: number | null;
  exclusiveShelf: ExclusiveShelf;
  shelves: string[];
  dateAdded: string | null;
  binding: Binding;
  geometry: Geometry;
  /** Null until the enrichment worker has processed this book. */
  palette: Palette | null;
  spineStyle: SpineStyle;
  /** Stable per-book integer driving every "varied but deterministic" choice. */
  seed: number;
  hasCover: boolean;
  /** width/height of the cached cover art, so it can be shown uncropped. */
  coverAspect: number | null;
  coverUrl: string;
  goodreadsUrl: string;
}

export type ShelfOrder = 'author' | 'added' | 'title' | 'colour' | 'pages';

export interface ShelfResponse {
  books: Book[];
  sections: { library: string[]; toRead: string[] };
  totals: {
    books: number;
    withCover: number;
    withPalette: number;
    withRealDimensions: number;
    enrichPending: number;
  };
}

export interface Prefs {
  theme: 'wood' | 'gallery' | 'academia';
  order: ShelfOrder;
  scale: number;
}

export interface Me {
  id: number;
  email: string;
  goodreadsUserId: string | null;
  isAdmin: boolean;
  prefs: Prefs;
  lastSyncAt: string | null;
}

export interface SyncStatus {
  running: boolean;
  nextRunAt: string | null;
  lastRun: {
    id: number;
    startedAt: string;
    finishedAt: string | null;
    trigger: 'schedule' | 'register' | 'manual' | 'csv';
    status: 'running' | 'ok' | 'partial' | 'failed';
    pagesFetched: number;
    itemsSeen: number;
    booksNew: number;
    booksUpdated: number;
    error: string;
  } | null;
  /** What the running system has actually observed about the Goodreads feed. */
  capability: {
    perPage200Works: boolean | null;
    pageParamWorks: boolean | null;
  };
  coverage: {
    /** True when every shelf walk terminated on a short page, i.e. provably complete. */
    complete: boolean;
    explanation: string;
  };
}
