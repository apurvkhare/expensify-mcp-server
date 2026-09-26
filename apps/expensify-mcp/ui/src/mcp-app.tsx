/**
 * The Expensify view: one dashboard shared by get_summary and list_expenses.
 *
 * It opens on the half the model asked for: totals and the breakdown for get_summary,
 * the table for list_expenses. The model often calls both tools in one turn, and two
 * full dashboards under one answer would just be the same screen twice. The other half
 * is one click away, fetched through the same two tools, as is every filter change.
 * Rows can be edited and deleted in place, through the same update_expense and delete_expense
 * tools the model uses; the view then tells the model what changed. Adding stays in the conversation.
 */
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Breakdown } from './Breakdown.tsx';
import { ExpenseTable } from './ExpenseTable.tsx';
import {
  GROUP_BY,
  fetchList,
  fetchSummary,
  isExpenseList,
  isSummary,
  listKey,
  summaryKey,
  type DateRange,
  type ExpenseList,
  type GroupBy,
  type Summary,
  type TableFilter
} from './data.ts';
import { formatINRWhole, formatRange, monthRange } from './format.ts';
import './app.css';

const DEFAULT_LIMIT = 20;

/** Which tool opened this view, and so which half it leads with. */
type Entry = 'summary' | 'list';

interface Seed {
  range: DateRange;
  groupBy?: GroupBy;
  filter: TableFilter;
}

/** Both tools share from/to; the rest of their arguments do not overlap, so read whatever is there. */
function seedFrom(args: Record<string, unknown> | undefined): Seed {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const groupBy = GROUP_BY.find((g) => g === args?.groupBy);
  return {
    range: { from: str(args?.from), to: str(args?.to) },
    groupBy,
    filter: { category: str(args?.category), merchant: str(args?.merchant), limit: typeof args?.limit === 'number' ? args.limit : DEFAULT_LIMIT }
  };
}

const entryFromTool = (app: App): Entry => (app.getHostContext()?.toolInfo?.tool.name === 'list_expenses' ? 'list' : 'summary');

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ExpensifyApp() {
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [range, setRange] = useState<DateRange>({});
  const [groupBy, setGroupBy] = useState<GroupBy>('category');
  const [filter, setFilter] = useState<TableFilter>({ limit: DEFAULT_LIMIT });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [list, setList] = useState<ExpenseList | null>(null);
  /** False until the model's own call has landed, so the view never races it for the same data. */
  const [ready, setReady] = useState(false);
  const [entry, setEntry] = useState<Entry>('summary');

  const seed = useRef<Seed>(seedFrom(undefined));
  /** Which query each half currently shows. A matching key means there is nothing to fetch. */
  const loaded = useRef({ summary: '', list: '' });

  const { app, error } = useApp({
    appInfo: { name: 'Expensify', version: '0.1.0' },
    capabilities: {},
    // Runs before connect(): the tool input, result, and cancellation arrive once, right after the handshake.
    onAppCreated: (created) => {
      created.addEventListener('toolinput', ({ arguments: args }) => {
        seed.current = seedFrom(args);
        setRange(seed.current.range);
        setFilter(seed.current.filter);
        if (seed.current.groupBy) setGroupBy(seed.current.groupBy);
      });
      created.addEventListener('toolresult', (result) => {
        const data = result.structuredContent;
        if (isSummary(data)) {
          loaded.current.summary = summaryKey(seed.current.range, data.groupBy);
          setGroupBy(data.groupBy);
          setSummary(data);
          setEntry('summary');
        } else if (isExpenseList(data)) {
          loaded.current.list = listKey(seed.current.range, seed.current.filter);
          setList(data);
          setEntry('list');
        } else {
          // An error result carries no data: go by the tool's name and let the view ask for itself.
          setEntry(entryFromTool(created));
        }
        setReady(true);
      });
      created.addEventListener('toolcancelled', () => {
        setEntry(entryFromTool(created));
        setReady(true);
      });
      created.addEventListener('hostcontextchanged', (ctx) => setHostContext((prev) => ({ ...prev, ...ctx })));
      created.onteardown = async () => ({});
      created.onerror = console.error;
    }
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);
  useHostStyles(app, hostContext);

  if (error) {
    return (
      <p className="state state-error" role="alert">
        Could not connect to the host: {error.message}
      </p>
    );
  }
  if (!app || !ready) return <p className="state">Loading expenses…</p>;

  return (
    <Dashboard
      app={app}
      entry={entry}
      insets={hostContext?.safeAreaInsets}
      loaded={loaded.current}
      state={{ range, groupBy, filter, summary, list }}
      set={{ setRange, setGroupBy, setFilter, setSummary, setList }}
    />
  );
}

interface DashboardProps {
  app: App;
  entry: Entry;
  insets: McpUiHostContext['safeAreaInsets'];
  loaded: { summary: string; list: string };
  state: { range: DateRange; groupBy: GroupBy; filter: TableFilter; summary: Summary | null; list: ExpenseList | null };
  set: {
    setRange(range: DateRange): void;
    setGroupBy(groupBy: GroupBy): void;
    setFilter(filter: TableFilter): void;
    setSummary(summary: Summary): void;
    setList(list: ExpenseList): void;
  };
}

function Dashboard({ app, entry, insets, loaded, state, set }: DashboardProps) {
  const { range, groupBy, filter, summary, list } = state;
  const { setRange, setGroupBy, setFilter, setSummary, setList } = set;
  /** Edits made from this view. Each one makes every earlier result stale, so it is part of the query keys. */
  const [version, setVersion] = useState(0);
  const changes = useRef<string[]>([]);
  /** The half the model did not ask for stays closed, and unfetched, until the user opens it. */
  const [expanded, setExpanded] = useState(false);
  const showSummary = entry === 'summary' || expanded;
  const showTable = entry === 'list' || expanded;
  const [summaryStatus, setSummaryStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [listStatus, setListStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  useEffect(() => {
    if (!showSummary) return;
    const key = summaryKey(range, groupBy, version);
    if (loaded.summary === key) return setSummaryStatus({ loading: false, error: null });
    let stale = false;
    setSummaryStatus({ loading: true, error: null });
    fetchSummary(app, range, groupBy).then(
      (next) => {
        if (stale) return;
        loaded.summary = key;
        setSummary(next);
        setSummaryStatus({ loading: false, error: null });
      },
      (err: unknown) => !stale && setSummaryStatus({ loading: false, error: message(err) })
    );
    return () => {
      stale = true;
    };
  }, [app, loaded, showSummary, range, groupBy, version, setSummary]);

  useEffect(() => {
    if (!showTable) return;
    const key = listKey(range, filter, version);
    if (loaded.list === key) return setListStatus({ loading: false, error: null });
    let stale = false;
    setListStatus({ loading: true, error: null });
    fetchList(app, range, filter).then(
      (next) => {
        if (stale) return;
        loaded.list = key;
        setList(next);
        setListStatus({ loading: false, error: null });
      },
      (err: unknown) => !stale && setListStatus({ loading: false, error: message(err) })
    );
    return () => {
      stale = true;
    };
  }, [app, loaded, showTable, range, filter, version, setList]);

  const onFilter = useCallback((next: TableFilter) => setFilter(next), [setFilter]);

  const onChanged = (description: string) => {
    setVersion((v) => v + 1);
    // The model did not make this change and would otherwise answer from stale numbers.
    // The host keeps only the latest context update, so send the whole list each time.
    changes.current.push(description);
    const text = `The user changed expenses directly in the Expensify dashboard. Earlier totals and lists in this conversation may be out of date:\n${changes.current.map((c) => `- ${c}`).join('\n')}`;
    app.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => {
      // Not every host takes context updates. The change itself is already saved.
    });
  };

  // A bar filters the table on the dimension it is grouped by, opening the table if it was closed.
  const selectedKey = groupBy === 'category' ? filter.category : groupBy === 'merchant' ? filter.merchant : undefined;
  const selected = showTable ? selectedKey : undefined;
  const onSelect = (key: string | undefined) => {
    if (groupBy === 'category') setFilter({ ...filter, category: key });
    else if (groupBy === 'merchant') setFilter({ ...filter, merchant: key });
    if (key !== undefined) setExpanded(true);
  };

  const presets: { label: string; range: DateRange }[] = [
    { label: 'This month', range: monthRange(0) },
    { label: 'Last month', range: monthRange(-1) },
    { label: 'All time', range: {} }
  ];
  const sameRange = (a: DateRange, b: DateRange) => a.from === b.from && a.to === b.to;

  return (
    <main style={{ paddingTop: insets?.top, paddingRight: insets?.right, paddingBottom: insets?.bottom, paddingLeft: insets?.left }}>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Date range">
          {presets.map((p) => (
            <button key={p.label} type="button" aria-pressed={sameRange(p.range, range)} onClick={() => setRange(p.range)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="dates">
          <label>
            <span>From</span>
            <input type="date" value={range.from ?? ''} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value || undefined })} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={range.to ?? ''} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value || undefined })} />
          </label>
        </div>
      </div>

      {showSummary && (
        <>
          <section className={`figures${summaryStatus.loading ? ' is-stale' : ''}`} aria-label="Totals">
            <div className="hero">
              <span className="figure-label">Total spend · {formatRange(range)}</span>
              <span className="figure-value">{summary ? formatINRWhole(summary.total) : '–'}</span>
            </div>
            <div className="tile">
              <span className="figure-label">Expenses</span>
              <span className="figure-value">{summary ? summary.count.toLocaleString('en-IN') : '–'}</span>
            </div>
            <div className="tile">
              <span className="figure-label">Average</span>
              <span className="figure-value">{summary && summary.count > 0 ? formatINRWhole(summary.total / summary.count) : '–'}</span>
            </div>
          </section>

          <Breakdown summary={summary} groupBy={groupBy} loading={summaryStatus.loading} error={summaryStatus.error} selected={selected} onGroupBy={setGroupBy} onSelect={onSelect} />
        </>
      )}
      {showTable && <ExpenseTable app={app} list={list} filter={filter} loading={listStatus.loading} error={listStatus.error} onFilter={onFilter} onChanged={onChanged} />}
      {!expanded && (
        <button type="button" className="link reveal" onClick={() => setExpanded(true)}>
          {entry === 'summary' ? 'Show the expenses behind these numbers' : 'Show totals and the spending breakdown'}
        </button>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExpensifyApp />
  </StrictMode>
);
