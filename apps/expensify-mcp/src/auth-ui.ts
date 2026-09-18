/**
 * The only part of the authorization server we write ourselves: who is signing in,
 * and which scopes they get. Everything else (metadata, registration, PKCE, tokens)
 * is handled by @cloudflare/workers-oauth-provider. In production this file is
 * replaced by your identity provider; the MCP code does not change.
 */
import { AuthorizationError, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { SCOPE_READ, SCOPE_WRITE } from './server.ts';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Only set for wrangler dev (.dev.vars). Deployed, the API binding is used instead. */
  API_BASE_URL?: string;
  /** Service binding to the REST Worker. Deployed, this is the only way in: the API has no public URL. */
  API: Fetcher;
  PUBLIC_URL: string;
  /** Worker secret: `wrangler secret put OWNER_PASSWORD`. Locally it comes from .dev.vars. */
  OWNER_PASSWORD?: string;
}

/** What the token carries into the MCP server. Encrypted into the token by the provider. */
export interface AuthProps {
  sub: string;
  name: string;
  scopes: string[];
}

/**
 * Two identities. The owner can write and needs the password. The guest is open to anyone
 * and only ever gets the read scope, so the write tools refuse it.
 */
export const USERS: Record<string, { name: string; role: string; scopes: string[]; password?: true }> = {
  apurv: { name: 'Apurv', role: 'owner', scopes: [SCOPE_READ, SCOPE_WRITE], password: true },
  guest: { name: 'Guest', role: 'viewer', scopes: [SCOPE_READ] }
};

/** Compare digests, not strings, so the check takes the same time however wrong the guess is. */
async function passwordMatches(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false; // no secret configured: the owner login stays shut
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;padding:24px 16px;background:Canvas;color:CanvasText;display:flex;justify-content:center}
  main{max-width:520px;width:100%}
  h1{font-size:1.4rem;margin:0 0 8px}
  p{line-height:1.5;margin:8px 0}
  .card{border:1px solid color-mix(in srgb, CanvasText 20%, transparent);border-radius:12px;padding:16px;margin:16px 0}
  button{display:block;width:100%;padding:14px;margin:10px 0;border-radius:10px;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);background:color-mix(in srgb, CanvasText 6%, Canvas);color:inherit;font:inherit;font-size:1rem;cursor:pointer;text-align:left}
  button:hover{background:color-mix(in srgb, CanvasText 12%, Canvas)}
  input{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0;border-radius:10px;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);background:Canvas;color:inherit;font:inherit;font-size:1rem}
  .err{color:#c0392b}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:color-mix(in srgb, CanvasText 8%, Canvas);padding:2px 6px;border-radius:6px}
  small{opacity:.7}
</style></head><body><main>${body}</main></body></html>`;

function landing(env: Env): Response {
  const mcpUrl = `${env.PUBLIC_URL}/mcp`;
  return new Response(
    page(
      'Expensify MCP',
      `<h1>Expensify MCP server</h1>
       <p>A personal expense tracker exposed over MCP (2026-07-28, Streamable HTTP, OAuth 2.1).</p>
       <div class="card">
         <p><strong>Claude Code</strong></p>
         <p><code>claude mcp add --transport http expensify ${mcpUrl}</code></p>
         <p>then <code>/mcp</code> and Authenticate, or <code>claude mcp login expensify</code>. Choose <strong>Guest</strong> on the login page: read-only, no password.</p>
         <p><strong>Cursor</strong></p>
         <p>Settings, Tools &amp; Integrations, Add custom MCP: <code>{"mcpServers":{"expensify":{"url":"${mcpUrl}"}}}</code>, then Needs login.</p>
       </div>
       <p><small>Metadata: <a href="/.well-known/oauth-protected-resource/mcp">protected resource</a> · <a href="/.well-known/oauth-authorization-server">authorization server</a> · <a href="/health">health</a></small></p>`
    ),
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function consent(req: AuthRequest, clientName: string, originalQuery: string, error?: string): Response {
  const action = `/authorize?${originalQuery}`;
  const forms = Object.entries(USERS)
    .map(
      ([id, u]) =>
        `<div class="card"><form method="post" action="${action}">
           ${u.password ? '<input type="password" name="password" placeholder="Owner password" autocomplete="current-password" required>' : ''}
           <button name="user" value="${id}">Sign in as ${u.name} <small>(${u.role}: ${u.scopes.join(', ')})</small></button>
         </form></div>`
    )
    .join('');
  return new Response(
    page(
      'Sign in to Expensify',
      `<h1>Sign in to Expensify</h1>
       <p><strong>${clientName}</strong> wants to access your expenses.</p>
       <p>Requested scopes: <code>${req.scope.join(' ') || '(none)'}</code></p>
       ${error ? `<p class="err">${error}</p>` : ''}
       ${forms}
       <p><small>Guest needs no password and can only read. Signing in grants the scopes shown, never more than requested.</small></p>`
    ),
    { status: error ? 401 : 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function authError(err: unknown): Response {
  if (err instanceof AuthorizationError) {
    if (err.redirectUri) {
      const u = new URL(err.redirectUri);
      u.searchParams.set('error', err.code);
      u.searchParams.set('error_description', err.description);
      if (err.state) u.searchParams.set('state', err.state);
      if (err.issuer) u.searchParams.set('iss', err.issuer);
      return Response.redirect(u.toString(), 302);
    }
    return new Response(`${err.code}: ${err.description}`, { status: 400 });
  }
  throw err;
}

/**
 * A Client ID Metadata Document for the MCP Inspector, so it can identify itself by URL
 * instead of registering dynamically. Normally the CLIENT hosts this on its own domain
 * (Claude Code ships one); we host one here only because the Inspector has no public URL.
 * The authorization server fetches it, checks client_id equals the URL, and checks the
 * redirect_uri in the request against this list. Spec: basic/authorization/client-registration.
 */
export const CIMD_PATH = '/clients/mcp-inspector.json';
function clientIdMetadataDocument(env: Env): Response {
  const clientId = `${env.PUBLIC_URL.replace(/\/+$/, '')}${CIMD_PATH}`;
  return Response.json(
    {
      client_id: clientId,
      client_name: 'MCP Inspector',
      client_uri: 'https://github.com/modelcontextprotocol/inspector',
      redirect_uris: [
        'http://localhost:6274/oauth/callback',
        'http://127.0.0.1:6274/oauth/callback',
        'http://127.0.0.1:6276/oauth/callback'
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}

/** Routes the OAuth provider does not own: landing page, health, the CIMD fixture, and the authorize UI. */
export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') return landing(env);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'expensify-mcp' });
    if (url.pathname === CIMD_PATH) return clientIdMetadataDocument(env);

    if (url.pathname === '/authorize') {
      let authReq: AuthRequest;
      try {
        authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (err) {
        return authError(err);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
      const clientName = client?.clientName ?? authReq.clientId;

      if (request.method === 'GET') return consent(authReq, clientName, url.searchParams.toString());

      if (request.method === 'POST') {
        const form = await request.formData();
        const userId = String(form.get('user') ?? '');
        const user = USERS[userId];
        if (!user) return new Response('Unknown user', { status: 400 });
        if (user.password && !(await passwordMatches(String(form.get('password') ?? ''), env.OWNER_PASSWORD))) {
          return consent(authReq, clientName, url.searchParams.toString(), 'Wrong password.');
        }

        // Grant the intersection of what the user may have and what the client asked for.
        const requested = authReq.scope.length ? authReq.scope : user.scopes;
        const granted = user.scopes.filter((s) => requested.includes(s));

        const props: AuthProps = { sub: userId, name: user.name, scopes: granted };
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId,
          metadata: { clientName, role: user.role },
          scope: granted,
          props
        });
        return Response.redirect(redirectTo, 302);
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
