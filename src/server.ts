import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, SERVICE_NAME } from './limits.js';
import { consoleLogger, type Logger } from './logger.js';
import type { IngestResult } from './types.js';
import { readPackageVersion } from './version.js';

export interface PingEndpoint {
  ingest(body: string, now?: Date): Promise<IngestResult>;
  count(): number;
}

export interface RunningServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  host: string;
  port: number;
  token: string;
  service: PingEndpoint;
  logger?: Logger;
}

interface BodyRead {
  kind: 'ok' | 'overflow';
  buffer: Buffer;
}

export function tokensMatch(expected: string, provided: string): boolean {
  const capped = provided.length > 4096 ? provided.slice(0, 4096) : provided;
  const left = Buffer.from(expected);
  const right = Buffer.from(capped);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function isFormUrlEncoded(header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  const media = header.split(';', 1)[0]?.trim().toLowerCase();
  return media === 'application/x-www-form-urlencoded';
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function readLimitedBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let overflow = false;
    const finish = (result: BodyRead | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    req.on('data', (chunk: Buffer) => {
      if (overflow) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        finish({ kind: 'overflow', buffer: Buffer.alloc(0) });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        return;
      }
      finish({ kind: 'ok', buffer: Buffer.concat(chunks) });
    });
    req.on('error', () => {
      if (!settled) {
        finish(new Error('request read failed'));
      }
    });
  });
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const logger = options.logger ?? consoleLogger;
  const version = readPackageVersion();
  const startedAt = Date.now();
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'request failed';
      logger.error(message);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal_error' });
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = req.headers.host ?? options.host;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${hostHeader}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    const path = normalizePath(url.pathname);

    if (path === '/health') {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const uptime = Number(((Date.now() - startedAt) / 1000).toFixed(3));
      sendJson(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        version,
        uptime_seconds: uptime,
        events: options.service.count(),
      });
      return;
    }

    if (path !== '/gumroad/ping') {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    const provided = url.searchParams.get('token') ?? '';
    if (!tokensMatch(options.token, provided)) {
      logger.info('rejected forbidden');
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      req.resume();
      return;
    }
    if (!isFormUrlEncoded(req.headers['content-type'])) {
      logger.info('rejected unsupported_media_type');
      sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
      req.resume();
      return;
    }

    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared) || Number(declared) > Number.MAX_SAFE_INTEGER) {
        sendJson(res, 400, { ok: false, error: 'bad_content_length' });
        req.resume();
        return;
      }
    }

    const body = await readLimitedBody(req, MAX_BODY_BYTES);
    if (body.kind === 'overflow') {
      logger.info('rejected payload_too_large');
      sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      res.on('finish', () => {
        req.destroy();
      });
      return;
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body.buffer);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_encoding' });
      return;
    }

    const result = await options.service.ingest(text);
    if (result.status === 'invalid') {
      logger.info('rejected validation');
      sendJson(res, 422, { ok: false, error: 'validation_failed', fields: result.errors });
      return;
    }
    logger.info(`${result.status} ${result.record.resource_name} ${result.record.sale_id}`);
    sendJson(res, 200, {
      ok: true,
      duplicate: result.status === 'duplicate',
      sale_id: result.record.sale_id,
      resource_name: result.record.resource_name,
      dedupe_key: result.record.dedupe_key,
      email_file: result.record.email_file,
      email_skipped_reason: result.record.email_skipped_reason,
    });
  }

  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (error) => {
    logger.error(error.message);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }

  return {
    host: options.host,
    port: address.port,
    async close(): Promise<void> {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
