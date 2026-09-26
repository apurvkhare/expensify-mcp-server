/**
 * Shapes the view receives, and the calls it makes back to the server.
 * The result shapes mirror the outputSchema of get_summary and list_expenses in src/server.ts.
 * The edit form validates with the same Zod schema the REST service and the tools use, so the
 * rules still exist exactly once (zod is in the bundle already: the Apps SDK brings it).
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { CATEGORIES, ExpenseInput, type ExpensePatch } from 'api-client';

export { CATEGORIES, type ExpensePatch };
/** What the edit form submits: every field of an expense except who created it. */
export const ExpenseForm = ExpenseInput.omit({ createdBy: true });

export type GroupBy = 'category' | 'merchant' | 'month';
export const GROUP_BY: readonly GroupBy[] = ['category', 'merchant', 'month'];

export interface Group {
  key: string;
  total: number;
  count: number;
}

export interface Summary {
  currency: 'INR';
  total: number;
  count: number;
  groupBy: GroupBy;
  groups: Group[];
}

export interface ExpenseRow {
  id: string;
  date: string;
  category: string;
  merchant: string;
  amount: number;
  note?: string;
}

export interface ExpenseList {
  count: number;
  /** False for read-only callers: the view then leaves out the edit and delete buttons. */
  editable?: boolean;
  expenses: ExpenseRow[];
}

export interface DateRange {
  from?: string;
  to?: string;
}

export interface TableFilter {
  category?: string;
  merchant?: string;
  limit: number;
}

export const isSummary = (v: unknown): v is Summary => typeof v === 'object' && v !== null && Array.isArray((v as Summary).groups);
export const isExpenseList = (v: unknown): v is ExpenseList => typeof v === 'object' && v !== null && Array.isArray((v as ExpenseList).expenses);

/**
 * Identity of a query, so a result the model already fetched is not fetched again.
 * `version` counts the edits made from the view: after one, every earlier result is stale.
 */
export const summaryKey = (range: DateRange, groupBy: GroupBy, version = 0) => JSON.stringify([range.from, range.to, groupBy, version]);
export const listKey = (range: DateRange, f: TableFilter, version = 0) => JSON.stringify([range.from, range.to, f.category, f.merchant, f.limit, version]);

function textOf(result: CallToolResult): string {
  return result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
}

async function call<T>(app: App, name: string, args: Record<string, unknown>, guard: (v: unknown) => v is T): Promise<T> {
  // Empty strings and undefined are "no filter"; the tool schemas reject them as values.
  const cleaned = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
  const result = await app.callServerTool({ name, arguments: cleaned });
  if (result.isError || !guard(result.structuredContent)) throw new Error(textOf(result) || `${name} returned nothing to show.`);
  return result.structuredContent;
}

export const fetchSummary = (app: App, range: DateRange, groupBy: GroupBy) => call(app, 'get_summary', { ...range, groupBy }, isSummary);

export const fetchList = (app: App, range: DateRange, f: TableFilter) => call(app, 'list_expenses', { ...range, ...f }, isExpenseList);

/**
 * The write tools answer in text only. Always select by id: by merchant they may need to ask
 * "which one?", and a view has no way to answer that. Read-only callers get the server's refusal as the error.
 */
async function write(app: App, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(textOf(result) || `${name} failed.`);
  return textOf(result);
}

export const updateExpense = (app: App, id: string, set: ExpensePatch) => write(app, 'update_expense', { id, set });
export const deleteExpense = (app: App, id: string) => write(app, 'delete_expense', { id });
