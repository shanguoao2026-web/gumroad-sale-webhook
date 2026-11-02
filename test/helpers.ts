import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FROM } from '../src/limits.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { PingService } from '../src/service.js';
import { startServer, type RunningServer } from '../src/server.js';

export const TOKEN = 'local-test-token-0123456789';

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'templates', 'sale.txt'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error('repository root not found');
}

export function templatesDir(): string {
  return join(repoRoot(), 'templates');
}

export function fixturesDir(): string {
  return join(repoRoot(), 'fixtures');
}

export function cliPath(): string {
  return join(repoRoot(), 'dist', 'src', 'cli.js');
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gumroad-sale-webhook-'));
}

export async function removeTemp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}

export function saleForm(overrides: Record<string, string> = {}): string {
  return formBody({
    seller_id: 'seller_nwp_01',
    product_id: 'prod_fieldnotes',
    product_name: 'Northwind Field Notes',
    email: 'ada.quill@example.com',
    full_name: 'Ada Quill',
    price: '1800',
    gumroad_fee: '230',
    currency: 'usd',
    quantity: '1',
    order_number: '100391',
    sale_id: 'sale_fieldnotes_1001',
    sale_timestamp: '2026-04-12T15:04:05Z',
    refunded: 'false',
    resource_name: 'sale',
    test: 'false',
    ip_country: 'US',
    ...overrides,
  });
}

export async function withService(fn: (service: PingService, dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  const service = new PingService({
    dataDir: dir,
    templatesDir: templatesDir(),
    from: DEFAULT_FROM,
  });
  try {
    await service.init();
    await fn(service, dir);
  } finally {
    await removeTemp(dir);
  }
}

export async function withServer(
  fn: (base: string, dir: string, running: RunningServer) => Promise<void>,
  logger: Logger = silentLogger,
): Promise<void> {
  const dir = await makeTempDir();
  const service = new PingService({
    dataDir: dir,
    templatesDir: templatesDir(),
    from: DEFAULT_FROM,
  });
  await service.init();
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    service,
    logger,
  });
  try {
    await fn(`http://127.0.0.1:${running.port}`, dir, running);
  } finally {
    await running.close();
    await removeTemp(dir);
  }
}
