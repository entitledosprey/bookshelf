import { memo } from 'react';
import type { Book } from '../types';
import { spineDims } from '../lib/geometry';
import { presentation, fitTitle, fitAuthor } from '../lib/spine-style';

interface Props {
  book: Book;
  scale: number;
  leaning?: boolean;
  isOpen: boolean;
  onOpen: (book: Book, el: HTMLElement) => void;
}

/**
 * One spine. Pure and memoised: at 400+ books, re-rendering these on every
 * parent state change is the difference between smooth and janky.
 *
 * All three palette values arrive as inline custom properties, which is the
 * only inline style here -- everything structural lives in spines.css.
 */
export const Spine = memo(function Spine({ book, scale, leaning, isOpen, onOpen }: Props) {
  const { width, height } = spineDims(book, scale);
  const p = presentation(book, { leaning, height });
  const title = fitTitle(book, height, p.textSpan);
  const author = p.showAuthor ? fitAuthor(book, height, title.length, p.textSpan) : '';
  const chars = Math.max(title.length + author.length + 2, 6);
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
      className={`book ${p.className}`}
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
        '--spine-bg': pal.bg,
        '--spine-accent': pal.accent,
        '--spine-text': pal.fg,
        '--spine-len': `${height}`,
        '--chars': `${chars}`,
        '--plate-text': p.plateText,
        '--text-span': `${p.textSpan}`,
        ...(p.lean != null ? { '--lean': `${p.lean}deg` } : {}),
      } as React.CSSProperties}
    >
      {book.spineStyle === 'banded-plate' && <span className="plate" aria-hidden="true" />}
      {book.spineStyle === 'two-tone-split' && <span className="tone" aria-hidden="true" />}
      {book.spineStyle === 'publisher-footer' && <span className="colophon" aria-hidden="true" />}
      {book.spineStyle === 'foil-rule' && (
        <>
          <span className="rule top" aria-hidden="true" />
          <span className="rule bottom" aria-hidden="true" />
        </>
      )}
      {(book.binding === 'hardcover' || book.binding === 'oversize') && (
        <>
          <span className="headband top" aria-hidden="true" />
          <span className="headband bottom" aria-hidden="true" />
        </>
      )}
      {book.binding === 'trade-paperback' && <span className="sheen" aria-hidden="true" />}
      {book.binding === 'mass-market' && (
        <span className="crease" aria-hidden="true" style={{ left: `${30 + (book.seed % 40)}%` }} />
      )}

      <span className="spine-text">
        <span className="spine-title">{title}</span>
        {author && <span className="spine-author">{author}</span>}
      </span>
    </button>
  );
});
