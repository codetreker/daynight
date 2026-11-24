import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect, type Socket } from 'node:net';
import path from 'node:path';

type Version = 'baseline' | 'candidate';
type Bundle = { html: string; assets: Map<string, Buffer> };

async function loadBundle(directory: string): Promise<Bundle> {
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  if (!html.includes('</head>')) throw new Error('Web bundle index is missing </head>.');
  const assets = new Map<string, Buffer>();
  const visit = async (parent: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const filename = path.join(parent, entry.name);
      if (entry.isDirectory()) await visit(filename, `${name}/`);
      else if (entry.isFile()) assets.set(`/assets/${name}`, await readFile(filename));
      else throw new Error(`Web artifact contains a nonregular entry: ${filename}`);
    }
  };
  await visit(path.join(directory, 'assets'), '');
  if (assets.size === 0) throw new Error('Web bundle contains no assets.');
  return { html, assets };
}

const contentType = (name: string): string => ({
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
} as Record<string, string>)[path.extname(name)] ?? 'application/octet-stream';

const isDocument = (request: IncomingMessage): boolean => {
  const pathname = (request.url ?? '').split('?', 1)[0]!;
  return (request.method === 'GET' || request.method === 'HEAD')
    && !pathname.startsWith('/api/') && !pathname.startsWith('/assets/')
    && !pathname.startsWith('/mcp') && (!pathname.startsWith('/auth/') || pathname === '/auth/complete')
    && !pathname.startsWith('/readyz');
};

export type CompatGateway = {
  server: Server;
  selectWeb: (version: Version) => void;
  close: () => Promise<void>;
};

// The selected shell may change between navigations. Hashed assets from both
// bundles remain available to already-open tabs at the same origin.
export async function createCompatGateway(options: {
  baselineWeb: string;
  candidateWeb: string;
  upstreamPort: number;
  appHost: string;
  previewOrigin: string;
  certificate: Buffer;
  key: Buffer;
  onTaskRequest?: (event: { method: string; path: string; query: { parentTaskId?: string; include?: string }; cancelDescendants?: boolean | null | 'invalid' }) => void;
}): Promise<CompatGateway> {
  if (!Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535) throw new Error('Invalid upstream port.');
  const bundles = {
    baseline: await loadBundle(options.baselineWeb),
    candidate: await loadBundle(options.candidateWeb),
  };
  const assets = new Map(bundles.baseline.assets);
  for (const [name, bytes] of bundles.candidate.assets) {
    const existing = assets.get(name);
    if (existing && !existing.equals(bytes)) throw new Error(`Web bundles contain different assets at the same URL: ${name}`);
    assets.set(name, bytes);
  }
  let selected: Version = 'candidate';
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const isApp = (request: IncomingMessage): boolean => {
    try { return new URL(`https://${request.headers.host ?? ''}`).hostname === options.appHost; }
    catch { return false; }
  };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const pathname = (request.url ?? '').split('?', 1)[0]!;
    if (isApp(request) && /^\/api\/v1\/projects\/[a-f0-9-]{36}\/tasks(?:\/[a-f0-9-]{36}(?:\/status)?)?$/.test(pathname)) {
      const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
      const parent = query.get('parentTaskId'), include = query.get('include');
      const event: { method: string; path: string; query: { parentTaskId?: string; include?: string }; cancelDescendants?: boolean | null | 'invalid' } = { method: request.method ?? '', path: pathname, query: {
        ...(parent === null ? {} : { parentTaskId: /^[a-f0-9-]{36}$/.test(parent) ? parent : '<invalid>' }),
        ...(include === null ? {} : { include: include === 'session' ? include : '<other>' }),
      } };
      if (request.method === 'PUT' && pathname.endsWith('/status')) {
        const chunks: Buffer[] = []; let size = 0;
        request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) chunks.push(chunk); });
        request.on('end', () => {
          let confirmation: boolean | null | 'invalid' = 'invalid';
          if (size <= 65_536) try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
              const value = (body as Record<string, unknown>).cancelDescendants;
              confirmation = value === undefined ? null : typeof value === 'boolean' ? value : 'invalid';
            }
          } catch { /* Invalid input is recorded without retaining its body. */ }
          options.onTaskRequest?.({ ...event, cancelDescendants: confirmation });
        });
      } else options.onTaskRequest?.(event);
    }
    if (isApp(request) && pathname.startsWith('/assets/') && (request.method === 'GET' || request.method === 'HEAD')) {
      // Do not decode URL paths or resolve filesystem paths from a request.
      const bytes = assets.get(pathname);
      if (!bytes) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': contentType(pathname), 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: `"${createHash('sha256').update(bytes).digest('hex')}"` });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return;
    }
    const requestedVersion = request.headers['x-daynight-e2e-web'];
    const version = requestedVersion === 'baseline' || requestedVersion === 'candidate' ? requestedVersion : selected;
    const replaceShell = isApp(request) && isDocument(request);
    const { 'x-daynight-e2e-web': _selection, ...headers } = request.headers;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: options.upstreamPort, method: request.method, path: request.url, headers: { ...headers, ...(replaceShell ? { 'accept-encoding': 'identity' } : {}) } }, incoming => {
      incoming.on('error', () => response.destroy());
      if (replaceShell && incoming.statusCode === 200 && incoming.headers['content-type']?.toLowerCase().startsWith('text/html')) {
        const escaped = options.previewOrigin.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const html = bundles[version].html.replace('</head>', `<meta name="daynight-preview-origin" content="${escaped}"></head>`);
        const body = Buffer.from(html);
        const headers = { ...incoming.headers, 'content-length': String(body.length), 'cache-control': 'no-store' };
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        delete headers.etag;
        response.writeHead(200, headers);
        response.end(request.method === 'HEAD' ? undefined : body);
        incoming.resume();
      } else {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      }
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  };
  const server = createServer({ cert: options.certificate, key: options.key }, handler);
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    const upstream = connect(options.upstreamPort, '127.0.0.1');
    track(upstream);
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    upstream.once('connect', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  return {
    server,
    selectWeb: version => { selected = version; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
