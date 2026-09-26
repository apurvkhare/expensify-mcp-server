# Expensify MCP server

A personal expense tracker exposed to AI hosts over the Model Context Protocol, built for the
MCP masterclass webinar. Spec revision 2026-07-28, TypeScript SDK v2, Cloudflare Workers free plan.

```
apps/expensify/        The REST service. Hono + D1. Exists "before MCP".
apps/expensify-mcp/    The MCP server. One factory, two entries: stdio (local) and Worker (remote, OAuth 2.1).
apps/expensify-mcp/ui/ The MCP App: a React dashboard that get_summary and list_expenses render into, on hosts that support it.
packages/api-client/   Zod shapes and a fetch client shared by both.
scripts/oauth-smoke.mjs  Walks the OAuth flow the way a host does, then calls tools. The "what does the host do" appendix.
```

## Run locally

```bash
npm install
npm run -w apps/expensify migrate:local && npm run -w apps/expensify seed
npm run api:dev          # http://localhost:8787
npm run mcp:ui           # build the MCP App view into apps/expensify-mcp/dist/mcp-app.html (the stdio entry reads it from there)
npm run mcp:dev          # http://localhost:8788  (OAuth + /mcp). Builds the view first
```

Local stdio server, talking to the local API:

```bash
EXPENSIFY_API_URL=http://localhost:8787 npx tsx apps/expensify-mcp/src/stdio.ts
npm run inspect          # MCP Inspector web UI, protocol era pinned to modern (2026-07-28) via inspector.json
claude mcp add expensify -e EXPENSIFY_API_URL=http://localhost:8787 -- npx tsx apps/expensify-mcp/src/stdio.ts
```

Remote, with the OAuth login page (owner with a password, plus a read-only guest with none):

```bash
claude mcp add --transport http expensify-remote http://localhost:8788/mcp
claude mcp login expensify-remote
node scripts/oauth-smoke.mjs http://localhost:8788          # as guest; owner: OWNER_PASSWORD=... <url> apurv
```

## What is where

| Concept | File |
|---|---|
| Tools with Zod schemas, annotations, `outputSchema` + `structuredContent`, `isError` | `apps/expensify-mcp/src/server.ts` |
| Resources (`expenses://this-month`, `expenses://categories`, `expenses://{id}`) with cache hints | same |
| Prompts (`monthly_report`, `import_statement`) | same |
| Elicitation as `input_required` (which Uber ride, confirm a large amount) | same, `resolveOne` and `add_expense` |
| Scope check inside tools, identity from the token | same, `callerFrom`, `canWrite` |
| MCP App: `registerAppTool` links the two read tools to `ui://expensify/dashboard.html`, `registerAppResource` serves it | same, `APP_RESOURCE_URI` |
| The view: host theming, tool input/result handlers, re-querying through `callServerTool` | `apps/expensify-mcp/ui/src/mcp-app.tsx` |
| Writing from the view: row edit and delete dialogs call `update_expense` / `delete_expense` by id, validate with the shared Zod schema, then `updateModelContext` tells the model what changed | `apps/expensify-mcp/ui/src/ExpenseDialogs.tsx` |
| How one HTML file reaches both entries: text module on Workers, `readFile` on stdio | `ServerDeps.appHtml`, `worker.ts`, `stdio.ts` |
| stdio entry, logs to stderr | `apps/expensify-mcp/src/stdio.ts` |
| Worker entry: OAuth provider wrapping `createMcpHandler`, host and origin guards | `apps/expensify-mcp/src/worker.ts` |
| The only auth code we write: who signs in, which scopes | `apps/expensify-mcp/src/auth-ui.ts` |
| One JSON log line per tool call | `apps/expensify-mcp/src/log.ts` |
| REST routes | `apps/expensify/src/index.ts` |

## Deploy (Cloudflare free plan)

Nothing tied to a Cloudflare account is in git. The `wrangler.jsonc` files and `inspector.json` use
`${D1_DATABASE_ID}`, `${KV_NAMESPACE_ID}` and `${WORKERS_SUBDOMAIN}`. Wrangler cannot read binding ids
from the environment, so `scripts/with-env.mjs` fills them in from the root `.env`, writes a gitignored
`wrangler.generated.jsonc`, and runs wrangler with it. Every npm script goes through it, so use
`npm run deploy`, not bare `npx wrangler deploy`. Local dev needs no `.env`.

```bash
cd apps/expensify
cp ../../.env.example ../../.env            # once
npx wrangler d1 create expensify            # put database_id in .env as D1_DATABASE_ID
npm run migrate:remote
npm run seed:remote
npm run deploy                               # no public URL: workers_dev is false, only the MCP Worker can call it

cd ../expensify-mcp
npx wrangler kv namespace create OAUTH_KV    # put the id in .env as KV_NAMESPACE_ID
# put your workers.dev subdomain in .env as WORKERS_SUBDOMAIN. The REST Worker is reached over the API binding, not a URL
npx wrangler secret put OWNER_PASSWORD       # the owner login password; guest needs none
npm run deploy
npm run logs                                 # readable live view; raw: npx wrangler tail expensify-mcp
```

Traces: `observability.traces.enabled` is on in both `wrangler.jsonc` files. Open the Worker in the
Cloudflare dashboard, Observability, Traces, to see one tool call as MCP request, fetch to the API, D1 query.

## Notes

- The REST service has no auth. Identity lives in the MCP layer, where the token is. Do not put real data in it.
- `add_expense` defaults the date to today in Asia/Kolkata. Models are bad at "today"; the server is not.
- The MCP Inspector CLI connects as a 2025-era client, so it cannot exercise `input_required`. Use the smoke script or a 2026 host for that.
