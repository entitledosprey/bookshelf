/**
 * A 1-5 star control.
 *
 * Built from real buttons rather than a styled range input so each star is its
 * own tap target and its own accessible name -- "3 stars" is what a screen
 * reader should hear, not "slider, 3".
 */
export function Stars({ value, onChange, label = 'Your rating' }: {
  value: number | null;
  onChange: (v: number | null) => void;
  label?: string;
}) {
  return (
    <div className="stars" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="star"
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          aria-pressed={value != null && n <= value}
          // Tapping the current rating again clears it, which is the only
          // obvious way to undo a misplaced tap.
          onClick={() => onChange(value === n ? null : n)}
        >
          {value != null && n <= value ? '★' : '☆'}
        </button>
      ))}
      {value != null && (
        <button type="button" className="star-clear" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </div>
  );
}
