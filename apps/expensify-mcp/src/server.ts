/**
 * The Expensify MCP server: a factory that builds a fresh McpServer per
 * serving unit (one HTTP request on Workers, one connection on stdio).
 * Nothing about the wire protocol appears here. Tools, resources, prompts,
 * the one place we ask the user a question, and the MCP App view the two
 * read tools share.
 */
import { RESOURCE_MIME_TYPE, getUiCapability, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ResourceTemplate,
  TRACEPARENT_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
  type AuthInfo,
  type CallToolResult,
  type ClientCapabilities,
  type Implementation,
  type InputRequiredResult,
  type ServerContext
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  ApiError,
  CATEGORIES,
  ExpenseInput,
  ExpensePatch,
  GROUP_BY,
  formatINR,
  todayIn,
  type ApiClient,
  type Expense
} from 'api-client';
import type { Logger } from './log.ts';

export const SCOPE_READ = 'expenses:read';
export const SCOPE_WRITE = 'expenses:write';
/** add_expense asks for confirmation at or above this amount. */
export const CONFIRM_THRESHOLD = 10_000;
/**
 * The dashboard both read tools render into, on hosts that support MCP Apps.
 * Hosts that do not simply ignore the link and show the text result as before.
 */
export const APP_RESOURCE_URI = 'ui://expensify/dashboard.html';

export interface Caller {
  subject: string;
  name: string;
  scopes: string[];
}

/** On stdio there is no token: the local user is the owner. Over HTTP the token decides. */
export function callerFrom(authInfo: AuthInfo | undefined): Caller {
  if (!authInfo) return { subject: 'local', name: 'Local user', scopes: [SCOPE_READ, SCOPE_WRITE] };
  const extra = (authInfo.extra ?? {}) as { sub?: string; name?: string };
  return {
    subject: extra.sub ?? authInfo.clientId,
    name: extra.name ?? extra.sub ?? authInfo.clientId,
    scopes: authInfo.scopes
  };
}

export interface ServerDeps {
  api: ApiClient;
  log: Logger;
  caller: Caller;
  /**
   * The built view (dist/mcp-app.html, from `npm run build:ui`). Each entry loads it its own way:
   * Workers has no filesystem and bundles it as a text module, stdio reads it from disk.
   */
  appHtml: () => string | Promise<string>;
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

function line(e: Expense): string {
  return `${e.id}  ${e.date}  ${e.category.padEnd(8)}  ${formatINR(e.amount).padStart(12)}  ${e.merchant}${e.note ? `  (${e.note})` : ''}`;
}

export function createExpensifyServer({ api, log, caller, appHtml }: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'expensify', version: '0.1.0', title: 'Expensify' },
    {
      instructions:
        'Personal expense tracker in INR. Use get_summary for totals instead of adding up list_expenses yourself. ' +
        'Dates are YYYY-MM-DD; add_expense defaults to today. Categories are fixed: read expenses://categories.',
      cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } }
    }
  );

  /**
   * Who is calling, and whether it can render the dashboard (hosts that render MCP Apps say so in their capabilities).
   * On 2026-07-28 every request carries this in its envelope, so it is read per request: there is no
   * initialize handshake, and on Workers each request gets a fresh server that never saw one anyway.
   * 2025-era clients send no envelope; for them the SDK keeps the initialize-scoped accessor working
   * (populated on stdio only). Delete that fallback once hosts negotiate 2026-07-28.
   */
  function clientOf(ctx: ServerContext) {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const info = (envelope?.[CLIENT_INFO_META_KEY] as Implementation | undefined) ?? server.server.getClientVersion();
    const capabilities = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
    return {
      client: info?.name,
      clientVersion: info?.version,
      protocol: typeof envelope?.[PROTOCOL_VERSION_META_KEY] === 'string' ? envelope[PROTOCOL_VERSION_META_KEY] : 'legacy',
      ui: getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false
    };
  }

  const canWrite = () => caller.scopes.includes(SCOPE_WRITE);
  const writeRefusal = () =>
    fail(`${caller.name} has read-only access (scopes: ${caller.scopes.join(' ') || 'none'}). Ask the owner to make this change.`);

  /**
   * Did the user say no? A declined or cancelled answer must end the call, not re-ask it.
   * (Without this, a host that cannot show the form loops until its round limit.)
   */
  function declined(ctx: ServerContext, key: string): boolean {
    const view = inputResponse(ctx.mcpReq.inputResponses, key);
    log({ event: 'input', key, kind: view.kind, action: view.kind === 'elicit' ? view.action : undefined, subject: caller.subject });
    return view.kind === 'elicit' && view.action !== 'accept';
  }

  /** Wraps a tool body with timing and one log line. Errors from the API become readable isError results. */
  function timed<R extends CallToolResult | InputRequiredResult>(
    tool: string,
    ctx: ServerContext,
    body: () => Promise<R>
  ): Promise<CallToolResult | InputRequiredResult> {
    const started = Date.now();
    const meta = (ctx.mcpReq._meta ?? {}) as Record<string, unknown>;
    const traceparent = typeof meta[TRACEPARENT_META_KEY] === 'string' ? meta[TRACEPARENT_META_KEY] : undefined;
    const client = clientOf(ctx);
    return body()
      .then((result) => {
        const isError = 'isError' in result && result.isError === true;
        log({ event: 'tool', tool, ms: Date.now() - started, ok: !isError, subject: caller.subject, ...client, traceparent });
        return result;
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        log({ event: 'tool', tool, ms: Date.now() - started, ok: false, subject: caller.subject, ...client, traceparent, error: message });
        return fail(`${tool} failed: ${message}`);
      });
  }

  // ---------------------------------------------------------------- tools

  registerAppTool(
    server,
    'list_expenses',
    {
      title: 'List expenses',
      description:
        'List expenses, newest first, with optional filters. Returns at most `limit` rows (max 50). ' +
        'For totals use get_summary; do not sum this list yourself. ' +
        'Hosts that render MCP Apps show this as an interactive table with the totals one click away, so one call is enough to show the user their expenses.',
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date YYYY-MM-DD, inclusive'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date YYYY-MM-DD, inclusive'),
        category: z.enum(CATEGORIES).optional(),
        merchant: z.string().min(1).optional().describe('Case-insensitive substring match'),
        limit: z.number().int().min(1).max(50).default(20)
      }),
      outputSchema: z.object({
        count: z.number().int(),
        // The view shows its edit and delete buttons from this. It is a courtesy, not the gate: the write tools check the scope themselves.
        editable: z.boolean().describe('Whether this caller may change these expenses (expenses:write)'),
        expenses: z.array(
          z.object({
            id: z.string(),
            date: z.string(),
            category: z.string(),
            merchant: z.string(),
            amount: z.number(),
            // Optional, not nullable: nullable emits type: ["string","null"], which some hosts reject.
            note: z.string().optional()
          })
        )
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } }
    },
    (args, ctx) =>
      timed('list_expenses', ctx, async () => {
        const rows = await api.list(args);
        const expenses = rows.map(({ id, date, category, merchant, amount, note }) => ({ id, date, category, merchant, amount, ...(note ? { note } : {}) }));
        return {
          content: [{ type: 'text', text: rows.length ? rows.map(line).join('\n') : 'No expenses match.' }],
          structuredContent: { count: rows.length, editable: canWrite(), expenses }
        };
      })
  );

  registerAppTool(
    server,
    'get_summary',
    {
      title: 'Spending summary',
      description:
        'Total spend and a breakdown grouped by category, merchant, or month. Use this for any "how much" question. ' +
        'Hosts that render MCP Apps show this as an interactive dashboard where the user can open the matching expenses themselves, ' +
        'so do not also call list_expenses just to display them.',
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date YYYY-MM-DD, inclusive'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date YYYY-MM-DD, inclusive'),
        groupBy: z.enum(GROUP_BY).default('category')
      }),
      outputSchema: z.object({
        currency: z.literal('INR'),
        total: z.number(),
        count: z.number().int(),
        groupBy: z.enum(GROUP_BY),
        groups: z.array(z.object({ key: z.string(), total: z.number(), count: z.number().int() }))
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } }
    },
    (args, ctx) =>
      timed('get_summary', ctx, async () => {
        const s = await api.summary(args);
        const lines = s.groups.map((g) => `${g.key.padEnd(14)} ${formatINR(g.total).padStart(14)}  (${g.count})`);
        return {
          content: [{ type: 'text', text: `Total ${formatINR(s.total)} across ${s.count} expenses, by ${s.groupBy}:\n${lines.join('\n') || '(none)'}` }],
          structuredContent: s
        };
      })
  );

  server.registerTool(
    'add_expense',
    {
      title: 'Add expense',
      description:
        `Record a new expense in rupees. Date defaults to today (${todayIn()}) when omitted. ` +
        `Amounts of ${formatINR(CONFIRM_THRESHOLD)} or more ask the user to confirm first.`,
      inputSchema: ExpenseInput.omit({ createdBy: true }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    (args, ctx) =>
      timed('add_expense', ctx, async () => {
        if (!canWrite()) return writeRefusal();

        let note = args.note;
        if (args.amount >= CONFIRM_THRESHOLD) {
          // Ask the user, not the model. The handler returns the question and runs again with the answer.
          // Accepting the form IS the confirmation. Never add a second yes inside it: a checkbox that
          // defaults to false means "Accept" + Enter still reads as no, and the call can never succeed.
          const answer = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
          log({ event: 'input', key: 'confirm', kind: answer.kind, action: answer.kind === 'elicit' ? answer.action : undefined, subject: caller.subject });

          if (answer.kind !== 'elicit') {
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message:
                    `Record ${formatINR(args.amount)} to ${args.merchant} (${args.category}) on ${args.date ?? todayIn()}? ` +
                    `Amounts of ${formatINR(CONFIRM_THRESHOLD)} or more need your confirmation. Accept to record, decline to cancel.`,
                  // One optional field, so the form carries something useful instead of repeating the question.
                  requestedSchema: {
                    type: 'object',
                    properties: { note: { type: 'string', title: 'Note (optional)', description: 'Shown next to the expense', default: args.note ?? '' } }
                  }
                })
              }
            });
          }
          if (answer.action !== 'accept') return fail('Not recorded: the user did not confirm.');
          const edited = typeof answer.content?.note === 'string' ? answer.content.note.trim() : '';
          if (edited) note = edited;
        }

        const created = await api.add({ ...args, note, createdBy: caller.subject });
        return text(`Recorded ${line(created)}`);
      })
  );

  /**
   * Find exactly one expense from an id, or from merchant + optional date.
   * Zero matches: readable error. Several: ask the user which one (input_required).
   */
  async function resolveOne(
    selector: { id?: string; merchant?: string; date?: string },
    ctx: ServerContext
  ): Promise<{ expense: Expense } | { result: CallToolResult | InputRequiredResult }> {
    if (selector.id) return { expense: await api.get(selector.id) };
    if (!selector.merchant) return { result: fail('Give an id, or a merchant (and optionally a date).') };

    const matches = await api.list({ merchant: selector.merchant, from: selector.date, to: selector.date, limit: 50 });
    if (matches.length === 0) return { result: fail(`No expense matches merchant "${selector.merchant}"${selector.date ? ` on ${selector.date}` : ''}.`) };
    if (matches.length === 1) return { expense: matches[0]! };

    if (declined(ctx, 'which')) return { result: fail('Cancelled: the user did not pick one.') };
    const picked = acceptedContent(ctx.mcpReq.inputResponses, 'which', z.object({ id: z.string() }));
    const chosen = picked && matches.find((m) => m.id === picked.id);
    if (chosen) return { expense: chosen };

    return {
      result: inputRequired({
        inputRequests: {
          which: inputRequired.elicit({
            message: `${matches.length} expenses match "${selector.merchant}". Which one?`,
            requestedSchema: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  title: 'Expense',
                  oneOf: matches.map((m) => ({ const: m.id, title: `${m.date}  ${formatINR(m.amount)}  ${m.merchant}${m.note ? ` (${m.note})` : ''}` }))
                }
              },
              required: ['id']
            }
          })
        }
      })
    };
  }

  const selectorSchema = {
    id: z.string().optional().describe('Expense id, when known'),
    merchant: z.string().min(1).optional().describe('Merchant to match when the id is not known'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Narrow a merchant match to one date')
  };

  server.registerTool(
    'update_expense',
    {
      title: 'Update expense',
      description:
        'Change fields on one expense. Select it by id, or by merchant (plus date to narrow). ' +
        'If several match, the user is asked which one.',
      inputSchema: z.object({ ...selectorSchema, set: ExpensePatch.describe('Fields to change') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args, ctx) =>
      timed('update_expense', ctx, async () => {
        if (!canWrite()) return writeRefusal();
        if (!Object.values(args.set).some((v) => v !== undefined)) return fail('Nothing to change: `set` is empty.');
        const r = await resolveOne(args, ctx);
        if ('result' in r) return r.result;
        const updated = await api.update(r.expense.id, args.set);
        return text(`Updated ${line(updated)}`);
      })
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Delete expense',
      description: 'Delete one expense. Select it by id, or by merchant (plus date to narrow). If several match, the user is asked which one.',
      inputSchema: z.object(selectorSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args, ctx) =>
      timed('delete_expense', ctx, async () => {
        if (!canWrite()) return writeRefusal();
        const r = await resolveOne(args, ctx);
        if ('result' in r) return r.result;
        const removed = await api.remove(r.expense.id);
        return text(`Deleted ${line(removed)}`);
      })
  );

  // ------------------------------------------------------------ resources

  // The view is self-contained (one HTML file, no network), so it declares no CSP domains.
  // It talks to this server only through the host: the two read tools to load, and update_expense
  // and delete_expense (always by id, so they never need to ask "which one?") for the row buttons.
  registerAppResource(
    server,
    'Expenses dashboard',
    APP_RESOURCE_URI,
    { description: 'Interactive view for get_summary and list_expenses: totals, a breakdown chart, and the expense table.' },
    async () => ({ contents: [{ uri: APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await appHtml() }] })
  );

  server.registerResource(
    'this-month',
    'expenses://this-month',
    {
      title: 'This month so far',
      description: 'Totals by category plus the latest entries for the current month.',
      mimeType: 'text/plain',
      cacheHint: { ttlMs: 30_000, cacheScope: 'private' }
    },
    async (uri) => {
      const today = todayIn();
      const from = today.slice(0, 7) + '-01';
      const [summary, latest] = await Promise.all([api.summary({ from, to: today }), api.list({ from, to: today, limit: 10 })]);
      const body = [
        `Expenses ${from} to ${today}: ${formatINR(summary.total)} across ${summary.count} entries`,
        '',
        ...summary.groups.map((g) => `${g.key.padEnd(14)} ${formatINR(g.total).padStart(14)}  (${g.count})`),
        '',
        'Latest:',
        ...latest.map(line)
      ].join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: body }] };
    }
  );

  server.registerResource(
    'categories',
    'expenses://categories',
    {
      title: 'Expense categories',
      description: 'The fixed list of valid categories. Reference data, safe to cache for a day.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' }
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(CATEGORIES) }] })
  );

  server.registerResource(
    'expense',
    new ResourceTemplate('expenses://{id}', { list: undefined }),
    { title: 'One expense', description: 'A single expense by id, as JSON.', mimeType: 'application/json' },
    async (uri, variables) => {
      const e = await api.get(String(variables.id));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(e, null, 2) }] };
    }
  );

  // -------------------------------------------------------------- prompts

  server.registerPrompt(
    'monthly_report',
    {
      title: 'Monthly spending report',
      description: 'Write a spending report for a month: totals by category, biggest items, anything unusual versus the month before.',
      argsSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe('YYYY-MM') })
    },
    ({ month }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Write a short spending report for ${month}. Steps: call get_summary grouped by category for the month, ` +
              `then get_summary for the previous month, then list_expenses for the month with limit 50. ` +
              `Report: total, top three categories with change versus last month, the three biggest single expenses, ` +
              `and one sentence on anything unusual. Keep it under 150 words. Amounts in INR.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'import_statement',
    {
      title: 'Import bank statement lines',
      description: 'Turn pasted statement lines into add_expense calls, asking before anything over 5,000.',
      argsSchema: z.object({ lines: z.string().min(1).describe('Raw statement lines, one per line') })
    },
    ({ lines }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Here are bank statement lines. For each, infer merchant, amount, date, and a category from expenses://categories. ` +
              `Call add_expense for each line. Before adding anything over 5,000 rupees, show me the parsed line and wait for my yes. ` +
              `Skip lines that are transfers or refunds and tell me which you skipped.\n\n${lines}`
          }
        }
      ]
    })
  );

  return server;
}
