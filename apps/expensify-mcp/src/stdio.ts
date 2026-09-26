/**
 * Local entry: the host spawns this process and speaks JSON-RPC over stdin/stdout.
 * stdout is the protocol channel, so every log line goes to stderr.
 *
 *   EXPENSIFY_API_URL=http://localhost:8787 npx tsx src/stdio.ts
 */
import { readFile } from 'node:fs/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createApiClient } from 'api-client';
import { stderrLogger } from './log.ts';
import { callerFrom, createExpensifyServer } from './server.ts';

const apiBaseUrl = process.env.EXPENSIFY_API_URL ?? 'http://localhost:8787';
const api = createApiClient(apiBaseUrl);
const log = stderrLogger({ transport: 'stdio' });

/** Read on demand, so a rebuilt view shows up without restarting the server. */
const appHtml = () =>
  readFile(new URL('../dist/mcp-app.html', import.meta.url), 'utf8').catch(() => {
    throw new Error('The view is not built. Run `npm run build:ui -w apps/expensify-mcp`.');
  });

serveStdio((ctx) => createExpensifyServer({ api, log, caller: callerFrom(ctx.authInfo), appHtml }), {
  onerror: (err) => log({ event: 'error', message: err.message })
});

log({ event: 'start', api: apiBaseUrl });
