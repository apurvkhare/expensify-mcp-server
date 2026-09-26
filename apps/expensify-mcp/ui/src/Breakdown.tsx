/**
 * Spend by category, merchant, or month: one series, so one hue and no legend.
 * Ranked horizontal bars with the value at the tip; share and count on hover or focus.
 * Category and merchant bars are buttons that cross-filter the table below.
 */
import { GROUP_BY, type Group, type GroupBy, type Summary } from './data.ts';
import { formatINRWhole, formatMonth, formatShare } from './format.ts';

/** Past this many bars the tail folds into one "Other" row rather than a wall of slivers. */
const MAX_BARS = 8;

interface Bar extends Group {
  label: string;
  /** Folded rows stand for several keys, so they cannot filter the table. */
  folded: boolean;
}

function toBars({ groups, groupBy }: Summary): Bar[] {
  if (groupBy === 'month') {
    // Time reads in order, not by rank.
    return [...groups].sort((a, b) => a.key.localeCompare(b.key)).map((g) => ({ ...g, label: formatMonth(g.key), folded: false }));
  }
  const ranked = [...groups].sort((a, b) => b.total - a.total);
  if (ranked.length <= MAX_BARS) return ranked.map((g) => ({ ...g, label: g.key, folded: false }));
  const head = ranked.slice(0, MAX_BARS - 1);
  const tail = ranked.slice(MAX_BARS - 1);
  return [
    ...head.map((g) => ({ ...g, label: g.key, folded: false })),
    {
      key: '__other',
      label: `Other (${tail.length})`,
      total: tail.reduce((sum, g) => sum + g.total, 0),
      count: tail.reduce((sum, g) => sum + g.count, 0),
      folded: true
    }
  ];
}

interface Props {
  summary: Summary | null;
  groupBy: GroupBy;
  loading: boolean;
  error: string | null;
  /** The table filter value this grouping maps to, if any. */
  selected?: string;
  onGroupBy(groupBy: GroupBy): void;
  onSelect(key: string | undefined): void;
}

export function Breakdown({ summary, groupBy, loading, error, selected, onGroupBy, onSelect }: Props) {
  const bars = summary ? toBars(summary) : [];
  const max = Math.max(0, ...bars.map((b) => b.total));
  const selectable = groupBy !== 'month';

  return (
    <section className="card" aria-labelledby="breakdown-title" aria-busy={loading}>
      <header className="card-head">
        <h2 id="breakdown-title">Spend by {groupBy}</h2>
        <div className="segmented" role="group" aria-label="Group by">
          {GROUP_BY.map((g) => (
            <button key={g} type="button" aria-pressed={g === groupBy} onClick={() => onGroupBy(g)}>
              {g}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p className="state state-error" role="alert">
          {error}
        </p>
      ) : !summary ? (
        <p className="state">Loading…</p>
      ) : bars.length === 0 ? (
        <p className="state">No spending in this range.</p>
      ) : (
        <ul className={`bars${loading ? ' is-stale' : ''}`}>
          {bars.map((bar) => {
            const detail = `${formatShare(bar.total, summary.total)} of total · ${bar.count} ${bar.count === 1 ? 'expense' : 'expenses'}`;
            const isSelected = selected !== undefined && selected.toLowerCase() === bar.key.toLowerCase();
            const body = (
              <>
                <span className="bar-label">{bar.label}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${max > 0 ? (bar.total / max) * 100 : 0}%` }} />
                  <span className="bar-tip" role="tooltip">
                    {detail}
                  </span>
                </span>
                <span className="bar-value">{formatINRWhole(bar.total)}</span>
              </>
            );
            return (
              <li key={bar.key} className={selected !== undefined && !isSelected ? 'is-dimmed' : undefined}>
                {selectable && !bar.folded ? (
                  <button
                    type="button"
                    className="bar-row"
                    aria-pressed={isSelected}
                    aria-label={`${bar.label}: ${formatINRWhole(bar.total)}, ${detail}. ${isSelected ? 'Clear table filter' : 'Filter the table'}`}
                    onClick={() => onSelect(isSelected ? undefined : bar.key)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="bar-row" tabIndex={0} aria-label={`${bar.label}: ${formatINRWhole(bar.total)}, ${detail}`}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
