import { memo } from 'react';
import type { Book } from '../types';
import { spineDims } from '../lib/geometry';
import { presentation, fitTitle, fitAuthor, type Imprint } from '../lib/spine-style';

interface Props {
  book: Book;
  scale: number;
  leaning?: boolean;
  isOpen: boolean;
  onOpen: (book: Book, el: HTMLElement) => void;
}

/** The small mark at the foot of a spine. Publishers nearly always put one there. */
function ImprintMark({ kind }: { kind: Imprint }) {
  if (kind === 'none') return null;
  return <span className={`imprint imprint-${kind}`} aria-hidden="true" />;
}

/**
 * One spine, composed rather than filled: a title block, an author block and an
 * imprint mark, divided by whatever rules or bands the layout calls for.
 *
 * A <button> so it keeps a real tap target, focus ring and accessible name.
 * Memoised because at 400+ books re-rendering these on every parent change is
 * the difference between smooth and janky.
 */
export const Spine = memo(function Spine({ book, scale, leaning, isOpen, onOpen }: Props) {
  const { width, height } = spineDims(book, scale);
  const p = presentation(book, { heightPx: height, leaning });
  const title = fitTitle(book, height, p.titleSpan);
  const author = p.showAuthor ? fitAuthor(book, height) : '';
  const pal = book.palette!;

  const label = [
    book.displayTitle,
    book.author,
    book.binding !== 'unknown' ? book.binding.replace('-', ' ') : null,
    book.published ? String(book.published) : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className={`book sl-${p.layout}`}
      data-binding={book.binding}
      data-updown={p.updown}
      {...(p.lean != null ? { 'data-lean': 'true' } : {})}
      aria-expanded={isOpen}
      aria-label={label}
      title={`${book.displayTitle} — ${book.author}`}
      onClick={(e) => onOpen(book, e.currentTarget)}
      style={{
        '--w': `${width}px`,
        '--h': `${height}px`,
        '--bg': pal.bg,
        '--ac': pal.accent,
        '--fg': pal.fg,
        '--plate-ink': p.plateInk,
        '--title-span': `${p.titleSpan}`,
        '--title-chars': `${Math.max(title.length, 4)}`,
        '--len': `${height}`,
        ...(p.lean != null ? { '--lean': `${p.lean}deg` } : {}),
      } as React.CSSProperties}
    >
      {/* Field decoration, behind the type. */}
      {p.layout === 'banded-head' && <span className="band" aria-hidden="true" />}
      {p.layout === 'two-field' && <span className="field" aria-hidden="true" />}
      {p.layout === 'plate' && <span className="plate" aria-hidden="true" />}
      {p.layout === 'foil-rules' && (
        <>
          <span className="rule rule-head" aria-hidden="true" />
          <span className="rule rule-foot" aria-hidden="true" />
        </>
      )}
      {p.layout === 'cloth-gilt' && (
        <>
          <span className="gilt gilt-head" aria-hidden="true" />
          <span className="gilt gilt-foot" aria-hidden="true" />
        </>
      )}

      {/* Head and tail bands sit above the cloth on a cased binding. */}
      {(book.binding === 'hardcover' || book.binding === 'oversize') && (
        <>
          <span className="headband headband-top" aria-hidden="true" />
          <span className="headband headband-bottom" aria-hidden="true" />
        </>
      )}
      {book.binding === 'trade-paperback' && <span className="laminate" aria-hidden="true" />}
      {book.binding === 'mass-market' && (
        <span className="crease" aria-hidden="true" style={{ left: `${32 + (book.seed % 36)}%` }} />
      )}

      {/* The composed type: title, author, imprint. */}
      <span className="spine-stack">
        <span className="spine-title">{title}</span>
        {author && <span className="spine-author">{author}</span>}
      </span>
      <ImprintMark kind={p.imprint} />
    </button>
  );
});
