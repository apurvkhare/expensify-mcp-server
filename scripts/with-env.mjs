#!/usr/bin/env node
/**
 * Wrangler cannot read binding ids from the environment: they must be written in the config file.
 * So the tracked configs use ${NAME} tokens, and this wrapper fills them in from the root .env
 * (or the real environment), writes a gitignored *.generated.* file, and runs the tool with it.
 *
 *   node scripts/with-env.mjs wrangler deploy            (run from an app folder)
 *   node scripts/with-env.mjs inspector --server name    (run from the repo root)
 *
 * Local commands work with no .env at all: missing values become harmless local placeholders.
 * Anything that touches Cloudflare (deploy, --remote) stops if a value is missing.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [tool, ...args] = process.argv.slice(2);

const TOOLS = {
  wrangler: { template: 'wrangler.jsonc', out: 'wrangler.generated.jsonc', cmd: ['wrangler'] },
  inspector: { template: 'inspector.json', out: 'inspector.generated.json', cmd: ['--yes', '@modelcontextprotocol/inspector@2'] }
};
const spec = TOOLS[tool];
if (!spec) {
  console.error('Usage: with-env.mjs <wrangler|inspector> [args]');
  process.exit(2);
}

// A tiny .env reader: KEY=value lines, # comments, optional quotes. The real environment wins.
const env = {};
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const template = readFileSync(spec.template, 'utf8');
const missing = new Set();
const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
  const value = process.env[name] || env[name];
  if (value) return value;
  missing.add(name);
  return `local-${name.toLowerCase().replaceAll('_', '-')}`;
});

const remote = tool === 'wrangler' && (args[0] === 'deploy' || args.includes('--remote'));
if (remote && missing.size) {
  console.error(`Missing in .env: ${[...missing].join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

writeFileSync(spec.out, rendered);
const child = spawn('npx', [...spec.cmd, ...args, '--config', spec.out], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
