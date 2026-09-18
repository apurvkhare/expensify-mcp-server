/**
 * Expensify: a small REST service on Cloudflare Workers + D1.
 * It exists "before MCP": a perfectly good API that a model still cannot call.
 * No auth in the code; the MCP server in front of it owns identity. Deployed, it has no public
 * URL (workers_dev: false), so only the MCP Worker can reach it, over a service binding.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as z from 'zod';
import {
  CATEGORIES,
  ExpenseInput,
  ExpensePatch,
  ListQuery,
  SummaryQuery,
  todayIn,
  type Expense,
  type Summary
} from 'api-client';

type Bindings = { DB: D1Database };
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

app.onError((err, c) => {
  console.log(JSON.stringify({ event: 'error', path: c.req.path, message: err.message }));
  return c.json({ error: 'Internal error' }, 500);
});

/** Row in D1 uses snake_case; the API speaks camelCase. */
type Row = {
  id: string;
  amount: number;
  currency: 'INR';
  category: Expense['category'];
  merchant: string;
  date: string;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
const toExpense = (r: Row): Expense => ({
  id: r.id,
  amount: r.amount,
  currency: r.currency,
  category: r.category,
  merchant: r.merchant,
  date: r.date,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

function parse<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}` };
}

function newId(): string {
  return 'exp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/** WHERE clause shared by list and summary. Merchant match is case-insensitive substring. */
function whereFor(q: { from?: string; to?: string; category?: string; merchant?: string }) {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (q.from) (clauses.push('date >= ?'), binds.push(q.from));
  if (q.to) (clauses.push('date <= ?'), binds.push(q.to));
  if (q.category) (clauses.push('category = ?'), binds.push(q.category));
  if (q.merchant) (clauses.push('lower(merchant) LIKE ?'), binds.push(`%${q.merchant.toLowerCase()}%`));
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

app.get('/health', (c) => c.json({ ok: true, service: 'expensify' }));

app.get('/categories', (c) => c.json(CATEGORIES));

app.get('/expenses', async (c) => {
  const parsed = parse(ListQuery, c.req.query());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const q = parsed.data;
  const w = whereFor(q);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM expenses ${w.sql} ORDER BY date DESC, created_at DESC LIMIT ?`
  )
    .bind(...w.binds, q.limit)
    .all<Row>();
  return c.json(results.map(toExpense));
});

// Declared before /expenses/:id so "summary" is not read as an id.
app.get('/expenses/summary', async (c) => {
  const parsed = parse(SummaryQuery, c.req.query());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const q = parsed.data;
  const w = whereFor(q);
  const keyExpr = q.groupBy === 'month' ? "substr(date, 1, 7)" : q.groupBy;
  const { results } = await c.env.DB.prepare(
    `SELECT ${keyExpr} AS key, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
       FROM expenses ${w.sql} GROUP BY key ORDER BY total DESC`
  )
    .bind(...w.binds)
    .all<{ key: string; total: number; count: number }>();
  const summary: Summary = {
    currency: 'INR',
    groupBy: q.groupBy,
    total: Math.round(results.reduce((s, g) => s + g.total, 0) * 100) / 100,
    count: results.reduce((s, g) => s + g.count, 0),
    groups: results
  };
  return c.json(summary);
});

app.get('/expenses/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!row) return c.json({ error: 'Expense not found' }, 404);
  return c.json(toExpense(row));
});

app.post('/expenses', async (c) => {
  const parsed = parse(ExpenseInput, await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const e = parsed.data;
  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO expenses (id, amount, category, merchant, date, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, e.amount, e.category, e.merchant, e.date ?? todayIn(), e.note ?? null, e.createdBy ?? 'apurv')
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first<Row>();
  return c.json(toExpense(row!), 201);
});

app.patch('/expenses/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = parse(ExpensePatch, await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const patch = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const res = await c.env.DB.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'Expense not found' }, 404);
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first<Row>();
  return c.json(toExpense(row!));
});

app.delete('/expenses/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first<Row>();
  if (!row) return c.json({ error: 'Expense not found' }, 404);
  await c.env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  return c.json(toExpense(row));
});

export default app;
