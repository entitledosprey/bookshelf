import type { Book } from '../types';
import { Spine } from './Spine';
import { rowHeight } from '../lib/geometry';

interface Props {
  row: Book[];
  scale: number;
  /** True for a partly filled final board, where the last books lean. */
  partial: boolean;
  openId: string | null;
  onOpen: (book: Book, el: HTMLElement) => void;
}

/** One board and the books standing on it. */
export function Shelf({ row, scale, partial, openId, onOpen }: Props) {
  const h = rowHeight(row, scale);
  // Books only lean when there are enough of them for leaning to look like
  // resting rather than collapsing. On a nearly empty shelf a real person uses
  // a bookend, so the books simply stand.
  const canLean = partial && row.length >= 8;
  const leanFrom = canLean ? Math.max(0, row.length - 2) : row.length;

  return (
    <div
      className="shelf"
      // --row-h is the tallest book; CSS multiplies it by the theme's --headroom
      // to size the opening, which is what puts visible case behind and above
      // the books. contain-intrinsic-size pairs with content-visibility: auto so
      // off-screen shelves skip layout while the scrollbar stays honest.
      style={{
        '--row-h': `${h}px`,
        containIntrinsicSize: `auto ${Math.round(h * 1.3) + 24}px`,
      } as React.CSSProperties}
    >
      <div className="shelf-opening">
        <div className="shelf-books">
          {row.map((book, i) => (
            <Spine
              key={book.id}
              book={book}
              scale={scale}
              leaning={i >= leanFrom}
              isOpen={openId === book.id}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
      <div className="shelf-board" aria-hidden="true" />
    </div>
  );
}
