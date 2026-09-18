/**
 * Shared shapes and a tiny fetch client for the Expensify REST service.
 * Both the Hono service and the MCP server import from here so the
 * validation rules exist exactly once.
 */
import * as z from 'zod';

export const CATEGORIES = ['food', 'travel', 'software', 'office', 'health', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const ExpenseInput = z.object({
  amount: z.number().positive().max(10_000_000).describe('Amount in rupees, for example 450 or 1299.5'),
  category: z.enum(CATEGORIES).describe('One of the fixed categories'),
  merchant: z.string().trim().min(1).max(80).describe('Who was paid, for example "Uber" or "Blue Tokai"'),
  date: isoDate.optional().describe('YYYY-MM-DD. Defaults to today when omitted.'),
  note: z.string().trim().max(200).optional().describe('Free text, optional'),
  createdBy: z.string().min(1).max(40).optional()
});
export type ExpenseInput = z.infer<typeof ExpenseInput>;

export const ExpensePatch = ExpenseInput.omit({ createdBy: true }).partial();
export type ExpensePatch = z.infer<typeof ExpensePatch>;

export const Expense = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.literal('INR'),
  category: z.enum(CATEGORIES),
  merchant: z.string(),
  date: isoDate,
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Expense = z.infer<typeof Expense>;

export const ListQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.enum(CATEGORIES).optional(),
  merchant: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
export type ListQuery = z.infer<typeof ListQuery>;

export const GROUP_BY = ['category', 'merchant', 'month'] as const;
export const SummaryQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  groupBy: z.enum(GROUP_BY).default('category')
});
export type SummaryQuery = z.infer<typeof SummaryQuery>;

export const Summary = z.object({
  currency: z.literal('INR'),
  total: z.number(),
  count: z.number().int(),
  groupBy: z.enum(GROUP_BY),
  groups: z.array(z.object({ key: z.string(), total: z.number(), count: z.number().int() }))
});
export type Summary = z.infer<typeof Summary>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function toQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface ApiClient {
  health(): Promise<{ ok: true; service: string }>;
  categories(): Promise<readonly Category[]>;
  list(query?: Partial<ListQuery>): Promise<Expense[]>;
  get(id: string): Promise<Expense>;
  add(input: ExpenseInput): Promise<Expense>;
  update(id: string, patch: ExpensePatch): Promise<Expense>;
  remove(id: string): Promise<Expense>;
  summary(query?: Partial<SummaryQuery>): Promise<Summary>;
}

/** A plain fetch wrapper. No auth: the MCP layer owns identity, the service is a demo. */
export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error ?? `${method} ${path} failed with ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return json as T;
  }

  return {
    health: () => call('GET', '/health'),
    categories: () => call('GET', '/categories'),
    list: (query = {}) => call('GET', `/expenses${toQuery(query)}`),
    get: (id) => call('GET', `/expenses/${encodeURIComponent(id)}`),
    add: (input) => call('POST', '/expenses', input),
    update: (id, patch) => call('PATCH', `/expenses/${encodeURIComponent(id)}`, patch),
    remove: (id) => call('DELETE', `/expenses/${encodeURIComponent(id)}`),
    summary: (query = {}) => call('GET', `/expenses/summary${toQuery(query)}`)
  };
}

/** Today's date as YYYY-MM-DD in a given IANA zone (defaults to India). */
export function todayIn(timeZone = 'Asia/Kolkata', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
}
