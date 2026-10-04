import { useEffect, useRef, useState } from 'react';
import type { Book } from '../types';
import { api, ApiError } from '../lib/api';
import { Stars } from './Stars';

interface Props {
  book: Book;
  neighbours: { prev: Book | null; next: Book | null };
  onClose: () => void;
  onNavigate: (book: Book) => void;
  /** Demo books are read-only: there is no account to save against. */
  readOnly?: boolean;
  onSaved?: (book: Book) => void;
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

export function BookSheet({ book, neighbours, onClose, onNavigate, readOnly, onSaved }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState(book.notes);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  const save = async (body: { myRating?: number | null; notes?: string }) => {
    setSaveState('saving');
    setSaveError('');
    try {
      const updated = await api.saveBook(book.id, body);
      onSaved?.(updated);
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof ApiError ? e.message : 'Could not save that.');
    }
  };

  // Save notes when the field loses focus, so nothing is lost by closing the
  // sheet, and nothing is written on every keystroke.
  const saveNotesIfChanged = () => {
    if (notes !== book.notes) void save({ notes });
  };

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
    setNotes(book.notes);
    setSaveState('idle');
    setSaveError('');
    if (ref.current) ref.current.scrollTop = 0;
  }, [book.id, book.notes]);

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
                 aria-label={book.coverPending
                   ? `Cover art for ${book.displayTitle} is still downloading`
                   : `No cover art available for ${book.displayTitle}`} />
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
          {/* Your own Goodreads star rating is deliberately not shown: the
              rating that matters here is the one you give below, and the
              community average is the only outside opinion worth the space. */}
          {book.averageRating && (
            <><dt>Average</dt><dd>{book.averageRating.toFixed(2)} <span className="hint">on Goodreads</span></dd></>
          )}
          {!book.hasCover && (
            <><dt>Cover</dt><dd className="provenance">
              {book.coverPending
                ? 'Cover art is still downloading. The spine colour below is already from the real jacket.'
                : 'No cover art found, so this spine uses a seeded cloth binding.'}
            </dd></>
          )}
        </dl>

        {!readOnly && (
          <section className="mine">
            <div className="mine-head">
              <h3>Your rating</h3>
              <span className="save-state" aria-live="polite">
                {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : ''}
              </span>
            </div>
            <Stars value={book.myRating} onChange={(v) => void save({ myRating: v })} />

            <h3>Your notes</h3>
            <textarea
              className="field notes"
              value={notes}
              rows={4}
              placeholder="Why you kept it, who lent it to you, where you stopped."
              aria-label="Your notes about this book"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotesIfChanged}
            />
            <div className="row">
              <button type="button" className="btn" disabled={notes === book.notes || saveState === 'saving'}
                      onClick={() => void save({ notes })}>
                {notes === book.notes ? 'Notes saved' : 'Save notes'}
              </button>
              {book.notesUpdatedAt && notes === book.notes && (
                <span className="hint">last edited {new Date(book.notesUpdatedAt).toLocaleDateString()}</span>
              )}
            </div>
            {saveError && <p className="error">{saveError}</p>}
          </section>
        )}

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
