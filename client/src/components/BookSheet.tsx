import { useEffect, useRef, useState } from 'react';
import type { Book } from '../types';

interface Props {
  book: Book;
  neighbours: { prev: Book | null; next: Book | null };
  onClose: () => void;
  onNavigate: (book: Book) => void;
}

const mm = (v: number) => `${Math.round(v)} mm`;

/** Says plainly whether the figures are measured or estimated. */
function provenance(book: Book): string {
  const g = book.geometry;
  switch (g.source) {
    case 'openlibrary': return 'measured, from Open Library';
    case 'googlebooks': return 'measured, from Google Books';
    case 'override': return 'corrected by hand';
    default:
      return book.pages
        ? `estimated from ${book.pages} pages`
        : 'estimated, no page count available';
  }
}

export function BookSheet({ book, neighbours, onClose, onNavigate }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    // showModal() autofocuses the first focusable child, and the browser scrolls
    // it into view -- which pushes the cover art off the top. Take focus on the
    // dialog itself (it is tabIndex -1) and reset the scroll.
    el.focus({ preventScroll: true });
    el.scrollTop = 0;
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  useEffect(() => {
    setFailed(false);
    if (ref.current) ref.current.scrollTop = 0;
  }, [book.id]);

  const pal = book.palette!;
  const thickness = Math.max(6, book.geometry.thicknessMm * 0.9);

  return (
    <dialog
      className="sheet"
      ref={ref}
      tabIndex={-1}
      aria-label={`${book.displayTitle} by ${book.author}`}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="sheet-stage">
        {/* The only 3D on the page: one element, one compositor layer. The
            left edge keeps the real spine colour at the real thickness, so the
            object stays recognisably the one that was tapped. */}
        <div
          className="opened"
          style={{
            '--spine-w': `${thickness}px`,
            '--spine-bg': pal.bg,
            '--placeholder': `linear-gradient(160deg, ${pal.bg}, ${pal.accent})`,
            '--cover-ratio': book.coverAspect ?? 2 / 3,
          } as React.CSSProperties}
        >
          <span className="opened-spine" aria-hidden="true" />
          {book.hasCover && !failed ? (
            <img
              className="opened-cover"
              src={book.coverUrl}
              alt={`Cover of ${book.displayTitle}`}
              loading="eager"
              decoding="async"
              onError={() => setFailed(true)}
            />
          ) : (
            <div className="opened-cover" role="img"
                 aria-label={`No cover art available for ${book.displayTitle}`} />
          )}
        </div>
      </div>

      <div className="sheet-body">
        <h2 className="sheet-title">{book.displayTitle}</h2>
        {book.series && (
          <p className="sheet-series">
            {book.series}{book.seriesPosition != null ? `, book ${book.seriesPosition}` : ''}
          </p>
        )}
        <p className="sheet-author">{book.author}</p>

        {book.shelves.length > 0 && (
          <div className="shelf-chips">
            {book.shelves.map((s) => <span className="chip" key={s}>{s}</span>)}
          </div>
        )}

        <dl className="facts">
          {book.binding !== 'unknown' && (
            <><dt>Binding</dt><dd>{book.binding.replace('-', ' ')}</dd></>
          )}
          {book.pages && <><dt>Pages</dt><dd>{book.pages}</dd></>}
          <dt>Size</dt>
          <dd>
            {mm(book.geometry.heightMm)} × {mm(book.geometry.widthMm)} × {mm(book.geometry.thicknessMm)}
            <br />
            <span className="provenance">{provenance(book)}</span>
          </dd>
          {book.published && <><dt>Published</dt><dd>{book.published}</dd></>}
          {book.userRating ? (
            <><dt>Your rating</dt>
              <dd className="rating">{'★'.repeat(book.userRating)}{'☆'.repeat(5 - book.userRating)}</dd></>
          ) : null}
          {book.averageRating && (
            <><dt>Average</dt><dd>{book.averageRating.toFixed(2)}</dd></>
          )}
          {!book.hasCover && (
            <><dt>Cover</dt><dd className="provenance">
              No cover art found, so this spine uses a seeded cloth binding.
            </dd></>
          )}
        </dl>

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <a className="link" href={book.goodreadsUrl} target="_blank" rel="noreferrer noopener">
            View on Goodreads
          </a>
        </div>
      </div>

      <div className="sheet-nav">
        <button
          type="button" className="btn btn-ghost"
          disabled={!neighbours.prev}
          onClick={() => neighbours.prev && onNavigate(neighbours.prev)}
        >
          Previous
        </button>
        <button
          type="button" className="btn btn-ghost"
          disabled={!neighbours.next}
          onClick={() => neighbours.next && onNavigate(neighbours.next)}
        >
          Next
        </button>
      </div>
    </dialog>
  );
}
