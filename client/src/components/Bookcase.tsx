import { useEffect, useMemo, useRef, useState } from 'react';
import type { Book, ShelfResponse } from '../types';
import { arrange, packShelves, type Order } from '../lib/geometry';
import { Shelf } from './Shelf';

interface Props {
  data: ShelfResponse;
  order: Order;
  scale: number;
  query: string;
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
export function Bookcase({ data, order, scale, query, openId, onOpen }: Props) {
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

  // Each section is its own case: uprights, back panel and a top and bottom
  // cap wrap the whole run of shelves, rather than each row floating alone.
  const section = (rows: Book[][], count: number) => (
    <div className="case">
      {rows.map((row, i) => (
        <Shelf
          key={`${i}-${row[0]?.id}`}
          row={row}
          scale={scale}
          partial={i === rows.length - 1 && count > row.length}
          openId={openId}
          onOpen={onOpen}
        />
      ))}
    </div>
  );

  return (
    <div className="bookcase">
      <div className="case case-probe" ref={ref} aria-hidden="true" />
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
