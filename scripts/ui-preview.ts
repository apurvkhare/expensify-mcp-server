/**
 * Local preview entry for the MCP App view. NOT for deployment.
 *
 * The SDK's basic-host test page speaks plain Streamable HTTP and cannot walk an OAuth
 * login, so it cannot use `npm run mcp:dev`. This serves the same createExpensifyServer
 * with no auth, as the local owner, bound to 127.0.0.1 only.
 *
 *   npm run api:dev        # terminal 1
 *   npm run mcp:preview    # terminal 2: builds the view, serves http://127.0.0.1:3001/mcp
 *                          # PREVIEW_READONLY=1 serves as the read-only guest: no edit or delete buttons
 *   # terminal 3, in a checkout of modelcontextprotocol/ext-apps, examples/basic-host:
 *   SERVERS='["http://127.0.0.1:3001/mcp"]' npx tsx serve.ts   # then open http://localhost:8080
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createApiClient } from 'api-client';
import { stderrLogger } from '../apps/expensify-mcp/src/log.ts';
import { SCOPE_READ, callerFrom, createExpensifyServer, type Caller } from '../apps/expensify-mcp/src/server.ts';

const port = Number(process.env.PREVIEW_PORT ?? 3001);
const apiBaseUrl = process.env.EXPENSIFY_API_URL ?? 'http://localhost:8787';
const api = createApiClient(apiBaseUrl);
const log = stderrLogger({ transport: 'preview' });
const caller: Caller = process.env.PREVIEW_READONLY ? { subject: 'guest', name: 'Guest', scopes: [SCOPE_READ] } : callerFrom(undefined);

/** Read per request, so `npm run watch:ui -w apps/expensify-mcp` shows up on the next tool call. */
const appHtml = () => readFile(new URL('../apps/expensify-mcp/dist/mcp-app.html', import.meta.url), 'utf8');

// basic-host runs in the browser on another port, so every response needs CORS.
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': '*'
};

http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
      });
      const handler = createMcpHandler(() => createExpensifyServer({ api, log, caller, appHtml }), {
        onerror: (err) => log({ event: 'error', message: err.message })
      });
      const response = await handler.fetch(request, {});
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...cors });
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (err) {
      log({ event: 'error', message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    }
  })
  .listen(port, '127.0.0.1', () => log({ event: 'start', url: `http://127.0.0.1:${port}/mcp`, api: apiBaseUrl }));
