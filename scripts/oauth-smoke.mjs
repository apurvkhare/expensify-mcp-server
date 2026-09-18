#!/usr/bin/env node
/**
 * Walks the whole OAuth 2.1 flow against a running expensify-mcp, the way a host does,
 * then makes one authenticated MCP call. Useful for rehearsal without a host.
 *
 *   node scripts/oauth-smoke.mjs http://localhost:8788 apurv
 *   node scripts/oauth-smoke.mjs https://expensify-mcp.<sub>.workers.dev apurv --cimd
 */
import { createHash, randomBytes } from 'node:crypto';

const base = (process.argv[2] ?? 'http://localhost:8788').replace(/\/+$/, '');
const user = process.argv[3] ?? 'apurv';
// --cimd: identify by Client ID Metadata Document URL instead of registering (deployed server only)
const useCimd = process.argv.includes('--cimd');
const mcpUrl = `${base}/mcp`;
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

// 1. Unauthenticated request → 401 with resource_metadata
step(1, 'POST /mcp without a token');
const r401 = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const challenge = r401.headers.get('www-authenticate') ?? '';
console.log(r401.status, challenge);
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? `${base}/.well-known/oauth-protected-resource/mcp`;

// 2. Protected Resource Metadata → authorization server
step(2, `GET ${prmUrl}`);
const prm = await (await fetch(prmUrl)).json();
console.log(prm);
const issuer = prm.authorization_servers[0];

// 3. Authorization server metadata
step(3, `GET ${issuer}/.well-known/oauth-authorization-server`);
const as = await (await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`)).json();
console.log({ authorization_endpoint: as.authorization_endpoint, token_endpoint: as.token_endpoint, registration_endpoint: as.registration_endpoint, code_challenge_methods_supported: as.code_challenge_methods_supported });

// 4. Client identity: a Client ID Metadata Document URL (2026 preferred) or Dynamic Client Registration (fallback)
const redirectUri = 'http://localhost:6274/oauth/callback';
let reg;
if (useCimd) {
  step(4, 'Client ID Metadata Document: client_id is a URL the authorization server will fetch');
  const cimdUrl = `${base}/clients/mcp-inspector.json`;
  console.log(await (await fetch(cimdUrl)).json());
  reg = { client_id: cimdUrl };
} else {
  step(4, 'POST registration (Dynamic Client Registration)');
  reg = await (
    await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'oauth-smoke', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
    })
  ).json();
  console.log({ client_id: reg.client_id });
}

// 5. Authorization request with PKCE and resource indicator
step(5, 'GET /authorize (the page the user sees)');
const verifier = randomBytes(32).toString('base64url');
const challengeCode = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(8).toString('hex');
const authUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, scope: prm.scopes_supported?.join(' ') ?? '',
  state, code_challenge: challengeCode, code_challenge_method: 'S256', resource: prm.resource
})) authUrl.searchParams.set(k, v);
const page = await fetch(authUrl);
console.log(page.status, page.headers.get('content-type'), '(consent page)');

// 6. The user clicks a button: POST the form back
step(6, `POST /authorize as "${user}"`);
const form = new URLSearchParams({ user });
const consent = await fetch(authUrl, { method: 'POST', body: form, redirect: 'manual' });
const location = consent.headers.get('location') ?? '';
console.log(consent.status, location.replace(/code=[^&]+/, 'code=…'));
if (consent.status !== 302 || !location) {
  console.log('Sign-in refused:', (await consent.text()).slice(0, 120));
  process.exit(1);
}
const cb = new URL(location);
if (cb.searchParams.get('state') !== state) throw new Error('state mismatch');
if (cb.searchParams.get('iss') && cb.searchParams.get('iss') !== issuer) throw new Error('iss mismatch');
const code = cb.searchParams.get('code');

// 7. Token exchange
step(7, 'POST /token with code + code_verifier + resource');
const tok = await (
  await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: prm.resource })
  })
).json();
if (process.env.TOKEN_OUT) (await import('node:fs')).writeFileSync(process.env.TOKEN_OUT, tok.access_token ?? '');
console.log({ token_type: tok.token_type, scope: tok.scope, expires_in: tok.expires_in, access_token: (tok.access_token ?? '').slice(0, 12) + '…' });

// 8. One MCP call with the bearer token (2026-07-28 request anatomy)
step(8, 'POST /mcp tools/call get_summary with Bearer token');
const mcpReq = {
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: {
    name: 'get_summary', arguments: { groupBy: 'category' },
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      // Declare what this client can render. Without elicitation.form the server must not ask (error -32021).
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
      'io.modelcontextprotocol/clientInfo': { name: 'oauth-smoke', version: '0.1.0' }
    }
  }
};
const res = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tok.access_token}`,
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_summary'
  },
  body: JSON.stringify(mcpReq)
});
console.log(res.status, res.headers.get('content-type'));
console.log((await res.text()).slice(0, 600));

// 9. A write as this user (needs the expenses:write scope; refused inside the tool without it)
step(9, 'POST /mcp tools/call add_expense');
const res2 = await fetch(mcpUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'add_expense' },
  body: JSON.stringify({ ...mcpReq, id: 2, params: { ...mcpReq.params, name: 'add_expense', arguments: { amount: 120, category: 'food', merchant: 'Smoke Test', note: `oauth-smoke as ${user}` } } })
});
const res2Text = await res2.text();
console.log(res2.status, res2Text.slice(0, 400));
const smokeId = /Recorded (exp_[a-z0-9]+)/i.exec(res2Text)?.[1];

// 10. Elicitation as a multi round-trip: several Uber rides match, the server asks which one, we answer.
step(10, 'POST /mcp tools/call update_expense merchant=Uber (expect input_required), then retry with the answer');
const call = (id, params) =>
  fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': params.name },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { ...params, _meta: mcpReq.params._meta } })
  }).then((r) => r.json());
const first = await call(3, { name: 'update_expense', arguments: { merchant: 'Uber', set: { note: `touched by oauth-smoke as ${user}` } } });
console.log('resultType:', first.result?.resultType, '| isError:', first.result?.isError ?? false);
const which = first.result?.inputRequests?.which;
if (which) {
  const options = which.params.requestedSchema.properties.id.oneOf;
  console.log('question:', which.params.message);
  console.log('options:', options.map((o) => o.title));
  const second = await call(4, {
    name: 'update_expense',
    arguments: { merchant: 'Uber', set: { note: `touched by oauth-smoke as ${user}` } },
    inputResponses: { which: { action: 'accept', content: { id: options[0].const } } }
  });
  console.log('retry ->', second.result?.resultType, second.result?.content?.[0]?.text ?? second.error);
  const third = await call(5, {
    name: 'update_expense',
    arguments: { merchant: 'Uber', set: { note: 'should not apply' } },
    inputResponses: { which: { action: 'decline' } }
  });
  console.log('declined ->', third.result?.resultType, '| isError:', third.result?.isError, '|', third.result?.content?.[0]?.text);
  // Put the note back so the demo data stays as seeded.
  const original = /\((.*)\)\s*$/.exec(options[0].title)?.[1];
  if (original) await call(50, { name: 'update_expense', arguments: { id: options[0].const, set: { note: original } } });
} else {
  console.log(JSON.stringify(first).slice(0, 400));
}

// 11. Confirmation above the threshold: accepting the form is the yes. No second checkbox.
step(11, 'add_expense 12000 (expect input_required), accept with an empty form, then clean up');
const big = { amount: 12000, category: 'software', merchant: 'Smoke Confirm', date: '2026-08-19', note: 'oauth-smoke' };
const ask = await call(6, { name: 'add_expense', arguments: big });
console.log('resultType:', ask.result?.resultType, '| message:', ask.result?.inputRequests?.confirm?.params?.message ?? ask.result?.content?.[0]?.text);
if (ask.result?.resultType === 'input_required') {
  const no = await call(7, { name: 'add_expense', arguments: big, inputResponses: { confirm: { action: 'decline' } } });
  console.log('decline ->', no.result?.isError, '|', no.result?.content?.[0]?.text);
  const yes = await call(8, { name: 'add_expense', arguments: big, inputResponses: { confirm: { action: 'accept', content: {} } } });
  const recorded = yes.result?.content?.[0]?.text ?? '';
  console.log('accept  ->', yes.result?.resultType, '| isError:', yes.result?.isError ?? false, '|', recorded);
  const id = /exp_[a-z0-9]+/i.exec(recorded)?.[0];
  if (id) console.log('cleanup ->', (await call(9, { name: 'delete_expense', arguments: { id } })).result?.content?.[0]?.text);
}

// Leave the data as we found it.
if (smokeId) console.log('\ncleanup ->', (await call(99, { name: 'delete_expense', arguments: { id: smokeId } })).result?.content?.[0]?.text);
