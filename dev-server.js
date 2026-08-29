/**
 * Local dev server. Zero dependencies, no global CLI to install.
 *
 * Serves public/ and routes POST /.netlify/functions/audit to the same
 * handler Netlify will run in production, so what you see here is what
 * deploys. `netlify dev` still works if the CLI is installed - see
 * `npm run dev:netlify` - this just removes it as a prerequisite.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import handler from './netlify/functions/audit.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8888;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

/** Node's IncomingMessage -> the WHATWG Request the v2 function expects. */
async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  });
}

async function sendResponse(res, response) {
  const buf = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(buf);
}

/**
 * Applies public/_headers the way Netlify does, so the CSP is enforced here
 * too. Without this, a broken policy - a stale hash, a missing directive -
 * would only ever show up in production, on the live site, to real visitors.
 */
async function loadHeaderRules() {
  try {
    const text = await readFile(join(PUBLIC, '_headers'), 'utf8');
    const rules = [];
    let current = null;
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) {
        current = { path: line.trim(), headers: {} };
        rules.push(current);
      } else if (current) {
        const at = line.indexOf(':');
        if (at > 0) current.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
    }
    return rules;
  } catch {
    return [];   // not built yet - serve without them
  }
}

const headerRules = await loadHeaderRules();

function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) {
    const matches = rule.path === '/*'
      ? true
      : rule.path.endsWith('/*')
        ? pathname.startsWith(rule.path.slice(0, -1))
        : rule.path === pathname;
    if (matches) Object.assign(out, rule.headers);
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/.netlify/functions/audit') {
    try {
      const response = await handler(await toRequest(req), { ip: req.socket.remoteAddress });
      await sendResponse(res, response);
    } catch (err) {
      console.error('function error:', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unexpected', title: 'Server error', message: String(err?.message || err) } }));
    }
    return;
  }

  // Static files, confined to public/.
  // Netlify consumes these at deploy time and never serves them. Matching that
  // here keeps the local server honest about what is actually public.
  if (/^\/_(headers|redirects)$/.test(url.pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...headersFor(url.pathname)
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use - something is serving there already.\n` +
      `Stop it, or run on another port:  PORT=8889 npm run dev`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Lead Capture Audit running at http://localhost:${PORT}`);
});
