/**
 * The rows behind the numbers. Category and merchant filters go to list_expenses;
 * sorting is local because the server only returns newest-first and at most 50 rows.
 * Callers with write access also get an edit and a delete button on every row.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { DeleteDialog, EditDialog } from './ExpenseDialogs.tsx';
import { CATEGORIES, type ExpenseList, type ExpenseRow, type TableFilter } from './data.ts';
import { formatDate, formatINR } from './format.ts';

const MAX_LIMIT = 50;

type SortKey = 'date' | 'merchant' | 'category' | 'amount';
interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'Date' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'category', label: 'Category' },
  { key: 'amount', label: 'Amount', numeric: true }
];

function sortRows(rows: ExpenseRow[], { key, dir }: Sort): ExpenseRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * (key === 'amount' ? a.amount - b.amount : a[key].localeCompare(b[key])));
}

/** 16px line icons, drawn in the text colour of the button that holds them. */
const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PENCIL = 'M11.2 2.6l2.2 2.2L5.2 13l-2.9.7.7-2.9zM9.8 4l2.2 2.2';
const TRASH = 'M2.8 4.5h10.4M6.4 4.5V3h3.2v1.5M4.2 4.5l.6 8.7h6.4l.6-8.7M6.8 7v3.8M9.2 7v3.8';

interface Props {
  app: App;
  list: ExpenseList | null;
  filter: TableFilter;
  loading: boolean;
  error: string | null;
  onFilter(filter: TableFilter): void;
  /** An expense was edited or deleted from a row: everything on screen is now stale. */
  onChanged(description: string): void;
}

interface OpenDialog {
  kind: 'edit' | 'delete';
  expense: ExpenseRow;
  anchorTop: number;
}

export function ExpenseTable({ app, list, filter, loading, error, onFilter, onChanged }: Props) {
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  // Older servers do not say; the write tools refuse read-only callers either way.
  const editable = list?.editable !== false;
  const open = (kind: OpenDialog['kind'], expense: ExpenseRow) => (e: MouseEvent<HTMLButtonElement>) =>
    setDialog({ kind, expense, anchorTop: e.currentTarget.getBoundingClientRect().top + window.scrollY });

  const [sort, setSort] = useState<Sort>({ key: 'date', dir: 'desc' });
  const rows = useMemo(() => (list ? sortRows(list.expenses, sort) : []), [list, sort]);

  // Typing should not fire a tool call per keystroke.
  const [merchantDraft, setMerchantDraft] = useState(filter.merchant ?? '');
  useEffect(() => setMerchantDraft(filter.merchant ?? ''), [filter.merchant]);
  useEffect(() => {
    const next = merchantDraft.trim() || undefined;
    if (next === filter.merchant) return;
    const timer = setTimeout(() => onFilter({ ...filter, merchant: next }), 350);
    return () => clearTimeout(timer);
  }, [merchantDraft, filter, onFilter]);

  const options = useMemo(() => {
    const seen = new Set<string>([...CATEGORIES, ...(list?.expenses.map((e) => e.category) ?? []), ...(filter.category ? [filter.category] : [])]);
    return [...seen];
  }, [list, filter.category]);

  const done = (description: string) => {
    setDialog(null);
    onChanged(description);
  };

  const filtered = Boolean(filter.category || filter.merchant);
  const truncated = list !== null && list.count >= filter.limit;

  return (
    <section className="card" aria-labelledby="table-title" aria-busy={loading}>
      <header className="card-head">
        <h2 id="table-title">Expenses</h2>
        <div className="filters">
          <label>
            <span className="visually-hidden">Category</span>
            <select value={filter.category ?? ''} onChange={(e) => onFilter({ ...filter, category: e.target.value || undefined })}>
              <option value="">All categories</option>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Merchant contains</span>
            <input type="search" placeholder="Merchant contains" value={merchantDraft} onChange={(e) => setMerchantDraft(e.target.value)} />
          </label>
          {filtered && (
            <button type="button" className="link" onClick={() => onFilter({ limit: filter.limit })}>
              Clear
            </button>
          )}
        </div>
      </header>

      {error ? (
        <p className="state state-error" role="alert">
          {error}
        </p>
      ) : !list ? (
        <p className="state">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="state">{filtered ? 'No expenses match these filters.' : 'No expenses in this range.'}</p>
      ) : (
        <>
          <div className={`table-scroll${loading ? ' is-stale' : ''}`}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((col) => {
                    const active = sort.key === col.key;
                    return (
                      <th key={col.key} scope="col" className={col.numeric ? 'num' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        <button
                          type="button"
                          onClick={() => setSort({ key: col.key, dir: active && sort.dir === 'desc' ? 'asc' : active ? 'desc' : col.key === 'date' || col.numeric ? 'desc' : 'asc' })}
                        >
                          {col.label}
                          <span className="sort-mark" aria-hidden="true">
                            {active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                  {editable && (
                    <th scope="col" className="actions">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatDate(e.date)}</td>
                    <td>
                      {e.merchant}
                      {e.note && <span className="note">{e.note}</span>}
                    </td>
                    <td>
                      <span className="pill">{e.category}</span>
                    </td>
                    <td className="num">{formatINR(e.amount)}</td>
                    {editable && (
                      <td className="actions">
                        <button type="button" className="icon-button" aria-label={`Edit ${e.merchant}, ${formatINR(e.amount)}, ${formatDate(e.date)}`} title="Edit" onClick={open('edit', e)}>
                          <Icon d={PENCIL} />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button-danger"
                          aria-label={`Delete ${e.merchant}, ${formatINR(e.amount)}, ${formatDate(e.date)}`}
                          title="Delete"
                          onClick={open('delete', e)}
                        >
                          <Icon d={TRASH} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="card-foot">
            <span>{truncated ? `Showing the newest ${list.count}` : `${list.count} ${list.count === 1 ? 'expense' : 'expenses'}`}</span>
            {truncated && filter.limit < MAX_LIMIT && (
              <button type="button" className="link" onClick={() => onFilter({ ...filter, limit: MAX_LIMIT })}>
                Show up to {MAX_LIMIT}
              </button>
            )}
          </footer>
        </>
      )}

      {dialog?.kind === 'edit' && <EditDialog app={app} expense={dialog.expense} anchorTop={dialog.anchorTop} onClose={() => setDialog(null)} onChanged={done} />}
      {dialog?.kind === 'delete' && <DeleteDialog app={app} expense={dialog.expense} anchorTop={dialog.anchorTop} onClose={() => setDialog(null)} onChanged={done} />}
    </section>
  );
}
