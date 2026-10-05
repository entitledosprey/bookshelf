import { Fragment } from 'react';
import type { Book, Decoration } from '../types';
import { Spine } from './Spine';
import { ShelfObject } from './Decorations';
import { rowHeight, spineDims } from '../lib/geometry';

interface Props {
  row: Book[];
  /** Books lying flat at the end of this row, if any. */
  stack: Book[];
  /** Framed photographs and objects standing on this particular shelf. */
  objects: Decoration[];
  scale: number;
  partial: boolean;
  openId: string | null;
  onOpen: (book: Book, el: HTMLElement) => void;
}

/** One plank and the books standing on it. */
export function Shelf({ row, stack, objects, scale, partial, openId, onOpen }: Props) {
  const h = Math.max(rowHeight(row, scale), ...stack.map((b) => spineDims(b, scale).width), 0);
  // Books only lean where there are enough of them for it to read as resting
  // rather than collapsing. On a nearly empty shelf a real person uses a
  // bookend, so they simply stand.
  const canLean = partial && stack.length === 0 && row.length >= 8;
  const leanFrom = canLean ? Math.max(0, row.length - 2) : row.length;

  // A flat stack is as wide as its widest book is tall.
  const stackW = stack.length
    ? Math.max(...stack.map((b) => spineDims(b, scale).height)) * 0.55
    : 0;

  return (
    <div
      className="shelf"
      style={{ containIntrinsicSize: `auto ${h + 24}px` } as React.CSSProperties}
    >
      <div className="shelf-row" style={{ minHeight: h }}>
        {row.map((book, i) => {
          // Objects stand between books, at their position along the shelf.
          const at = row.length ? i / row.length : 0;
          const next = row.length ? (i + 1) / row.length : 1;
          const here = objects.filter((o) => o.position >= at && o.position < next);
          return (
            <Fragment key={book.id}>
              <Spine
                book={book}
                scale={scale}
                leaning={i >= leanFrom}
                isOpen={openId === book.id}
                onOpen={onOpen}
              />
              {here.map((o) => <ShelfObject key={o.id} item={o} scale={scale} />)}
            </Fragment>
          );
        })}
        {/* Anything positioned past the last book stands at the end. */}
        {objects.filter((o) => o.position >= 1 || row.length === 0)
          .map((o) => <ShelfObject key={o.id} item={o} scale={scale} />)}

        {stack.length > 0 && (
          <div className="stack" style={{ '--stack-w': `${Math.round(stackW)}px` } as React.CSSProperties}>
            {stack.map((book) => (
              <Spine
                key={book.id}
                book={book}
                scale={scale}
                isOpen={openId === book.id}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
      <div className="plank" aria-hidden="true" />
    </div>
  );
}
