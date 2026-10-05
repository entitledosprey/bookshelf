import { useEffect, useMemo, useRef, useState } from 'react';
import type { Book, Decoration, ShelfResponse } from '../types';
import { arrange, packShelves, spineDims, type Order } from '../lib/geometry';
import { Shelf } from './Shelf';

interface Props {
  data: ShelfResponse;
  order: Order;
  scale: number;
  query: string;
  /** Lay some books flat, rather than standing every one upright. */
  stacks: boolean;
  decorations: Decoration[];
  /** Reports how many shelves there are, so objects can be assigned to one. */
  onShelfCount?: (n: number) => void;
  openId: string | null;
  onOpen: (book: Book, el: HTMLElement) => void;
}

/**
 * Measure the width books actually get.
 *
 * This must be measured INSIDE a .case, not on the container: the case's
 * uprights are borders whose width is a per-theme token, so the usable width is
 * narrower than the bookcase and by a different amount in each theme. Measuring
 * the outer element overflows the books past the right upright.
 *
 * The probe carries the real .case class and is hidden and out of flow, so it
 * always reports the same content width the visible cases have.
 */
function useBoardWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * The bookcase: a "Library" section of read and in-progress books, then a
 * separate labelled "To read" section. Keeping them apart is a deliberate
 * product choice -- an unread book is a different kind of object on a shelf.
 */
export function Bookcase({ data, order, scale, query, stacks, decorations, onShelfCount, openId, onOpen }: Props) {
  const [ref, boardWidth] = useBoardWidth();

  const { library, toRead } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: Book) =>
      !q ||
      b.title.toLowerCase().includes(q) ||
      b.author.toLowerCase().includes(q) ||
      (b.series ?? '').toLowerCase().includes(q);

    const all = data.books.filter(match);
    return {
      library: arrange(all.filter((b) => b.exclusiveShelf !== 'to-read'), order),
      toRead: arrange(all.filter((b) => b.exclusiveShelf === 'to-read'), order),
    };
  }, [data.books, order, query]);

  // Pack against the REAL width so a row fills the shelf, but key the memo on a
  // 24px bucket so dragging a window edge does not re-pack on every pixel.
  const bucket = Math.floor(boardWidth / 24) * 24;
  const libraryRows = useMemo(
    () => (boardWidth ? packShelves(library, boardWidth, scale) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, bucket, scale],
  );
  const toReadRows = useMemo(
    () => (boardWidth ? packShelves(toRead, boardWidth, scale) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toRead, bucket, scale],
  );

  /**
   * Each row is a plank. When stacks are on, the last few books of a full row
   * are laid flat at its end instead of standing — which is how a real shelf
   * absorbs the ones that do not quite fit, and stops every row reading as an
   * identical picket fence.
   */
  const section = (rows: Book[][], count: number) =>
    rows.map((row, i) => {
      const lastRow = i === rows.length - 1;
      // Seeded off the first book so a given shelf always decides the same way,
      // and roughly half of them end with a flat stack rather than every other
      // one, which would read as a pattern.
      const seeded = ((rows[i][0]?.seed ?? i) % 10) < 5;

      // A stack lying flat is as wide as its books are tall, which is far wider
      // than the two upright spines it replaces. Only lay one down if the row
      // actually has the slack for it, or it overhangs the end of the shelf.
      const last2 = row.slice(-2);
      const spineW = (b: Book) => spineDims(b, scale).width + 2;
      const rowW = row.reduce((a, b) => a + spineW(b), 0);
      const stackW = last2.length
        ? Math.max(...last2.map((b) => spineDims(b, scale).height)) * 0.55
        : 0;
      const fits = rowW - last2.reduce((a, b) => a + spineW(b), 0) + stackW + 10 <= boardWidth;

      const wantsStack = stacks && !lastRow && row.length > 6 && seeded && fits;
      const stack = wantsStack ? last2 : [];
      const upright = wantsStack ? row.slice(0, -2) : row;
      return (
        <Shelf
          key={`${i}-${row[0]?.id}`}
          row={upright}
          stack={stack}
          objects={decorations.filter((d) => d.shelfIndex === i)}
          scale={scale}
          partial={lastRow && count > row.length}
          openId={openId}
          onOpen={onOpen}
        />
      );
    });

  // Report the shelf count so the object picker can offer real shelves.
  useEffect(() => {
    onShelfCount?.(libraryRows.length + toReadRows.length);
  }, [libraryRows.length, toReadRows.length, onShelfCount]);

  return (
    <div className="bookcase">
      <div className="case-probe" ref={ref} aria-hidden="true" />
      {library.length > 0 && section(libraryRows, library.length)}

      {toRead.length > 0 && (
        <>
          <h2 className="section-label">
            To read <span className="n">{toRead.length}</span>
          </h2>
          {section(toReadRows, toRead.length)}
        </>
      )}

      {library.length === 0 && toRead.length === 0 && (
        <p className="notice">
          {query ? `Nothing on your shelves matches “${query}”.` : 'No books yet.'}
        </p>
      )}
    </div>
  );
}
