/**
 * Remote entry on Cloudflare Workers.
 *
 *   OAuthProvider  owns /authorize, /token, /register, both .well-known documents,
 *                  and the bearer check on /mcp. It hands us ctx.props.
 *   createMcpHandler(factory) serves /mcp: the factory runs once per request.
 *
 * Same createExpensifyServer as stdio. Nothing in the server changed to go remote.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, type AuthInfo } from '@modelcontextprotocol/server';
import { createApiClient } from 'api-client';
import { USERS, defaultHandler, type AuthProps, type Env } from './auth-ui.ts';
import { consoleLogger } from './log.ts';
import { SCOPE_READ, SCOPE_WRITE, callerFrom, createExpensifyServer } from './server.ts';

const log = consoleLogger({ transport: 'http' });

/** Protected route. The provider has already verified the token; we map its props to the SDK's AuthInfo. */
const mcpApi: ExportedHandler<Env> & Required<Pick<ExportedHandler<Env>, 'fetch'>> = {
  async fetch(request, env, ctx) {
    const allowedHost = new URL(env.PUBLIC_URL).hostname;
    const rejected =
      hostHeaderValidationResponse(request, [allowedHost, 'localhost', '127.0.0.1']) ??
      originValidationResponse(request, [allowedHost, 'localhost', '127.0.0.1']);
    if (rejected) return rejected;

    const props = (ctx as ExecutionContext<AuthProps>).props;
    // A token is only as good as the user behind it. Removing someone from USERS cuts off
    // tokens and refresh grants that were issued to them earlier, immediately.
    if (!props?.sub || !USERS[props.sub]) {
      log({ event: 'auth', ok: false, reason: 'unknown_user', subject: props?.sub });
      return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'This user no longer has access.' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' }
      });
    }
    const authInfo: AuthInfo = {
      token: request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      clientId: props.sub,
      scopes: props.scopes,
      extra: { sub: props.sub, name: props.name }
    };

    // Deployed, the REST service has no public URL. We reach it over a service binding:
    // Worker to Worker inside Cloudflare, never over the internet. For wrangler dev,
    // .dev.vars sets API_BASE_URL and we call that instead.
    const binding = env.API;
    const api = env.API_BASE_URL
      ? createApiClient(env.API_BASE_URL)
      : createApiClient('http://expensify', (input, init) => binding.fetch(input, init));
    const handler = createMcpHandler((mcpCtx) => createExpensifyServer({ api, log, caller: callerFrom(mcpCtx.authInfo) }), {
      onerror: (err) => log({ event: 'error', message: err.message })
    });
    try {
      return await handler.fetch(request, { authInfo });
    } finally {
      ctx.waitUntil(handler.close());
    }
  }
};

/** The provider needs the public URL for its metadata, and env is only known per request, so build it lazily. */
let provider: OAuthProvider<Env> | undefined;
let providerFor: string | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  if (provider && providerFor === env.PUBLIC_URL) return provider;
  const origin = env.PUBLIC_URL.replace(/\/+$/, '');
  providerFor = env.PUBLIC_URL;
  provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApi,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    // 2026-07-28 prefers Client ID Metadata Documents; DCR stays on for older hosts.
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/register',
    scopesSupported: [SCOPE_READ, SCOPE_WRITE],
    // The provider insists on an https issuer. On the deployed URL we state the metadata explicitly;
    // on http://localhost (wrangler dev) we let it derive resource and issuer from the request.
    resourceMetadata: origin.startsWith('https://')
      ? {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          // Both scopes, so a host asks for both up front; the consent step narrows per user.
          // (Step-up on 403 is the spec's alternative; host support for it is uneven.)
          scopes_supported: [SCOPE_READ, SCOPE_WRITE],
          resource_name: 'Expensify MCP'
        }
      : { scopes_supported: [SCOPE_READ, SCOPE_WRITE], resource_name: 'Expensify MCP' },
    accessTokenTTL: 60 * 60
  });
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
