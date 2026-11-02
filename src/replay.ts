import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_BODY_BYTES } from './limits.js';
import type { PingService } from './service.js';
import { normalizeFormBody } from './validate.js';

export interface ReplayItem {
  file: string;
  status: 'accepted' | 'duplicate' | 'rejected' | 'error';
  sale_id: string;
  resource_name: string;
  detail: string;
}

export interface ReplayReport {
  items: ReplayItem[];
  accepted: number;
  duplicate: number;
  rejected: number;
  error: number;
}

export function exitCodeForReport(report: ReplayReport): number {
  return report.rejected + report.error > 0 ? 1 : 0;
}

export async function listFixtures(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) {
    if (!target.endsWith('.form')) {
      throw new Error('fixture file must end with .form');
    }
    return [target];
  }
  if (!info.isDirectory()) {
    throw new Error('fixtures path must be a file or directory');
  }
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.form'))
    .map((entry) => join(target, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

export function withToken(endpoint: string, token: string | null): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('--url must be an http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--url must be an http or https URL');
  }
  if (!url.searchParams.get('token')) {
    if (!token) {
      throw new Error('replay --url needs a token query parameter or --token');
    }
    url.searchParams.set('token', token);
  }
  return url.toString();
}

async function readFixture(file: string): Promise<string> {
  const buffer = await readFile(file);
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error('fixture exceeds the body size limit');
  }
  return normalizeFormBody(buffer.toString('utf8'));
}

function tally(items: ReplayItem[]): ReplayReport {
  return {
    items,
    accepted: items.filter((item) => item.status === 'accepted').length,
    duplicate: items.filter((item) => item.status === 'duplicate').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
    error: items.filter((item) => item.status === 'error').length,
  };
}

export async function replayLocal(service: PingService, fixturesPath: string): Promise<ReplayReport> {
  const files = await listFixtures(fixturesPath);
  if (files.length === 0) {
    throw new Error(`no fixtures found at ${fixturesPath}`);
  }
  const items: ReplayItem[] = [];
  for (const file of files) {
    const name = basename(file);
    try {
      const body = await readFixture(file);
      const result = await service.ingest(body);
      if (result.status === 'invalid') {
        items.push({
          file: name,
          status: 'rejected',
          sale_id: '',
          resource_name: '',
          detail: result.errors.join('; '),
        });
        continue;
      }
      items.push({
        file: name,
        status: result.status,
        sale_id: result.record.sale_id,
        resource_name: result.record.resource_name,
        detail: result.record.email_skipped_reason ?? result.record.email_file ?? '',
      });
    } catch (error) {
      items.push({
        file: name,
        status: 'error',
        sale_id: '',
        resource_name: '',
        detail: error instanceof Error ? error.message : 'replay failed',
      });
    }
  }
  return tally(items);
}

export async function replayHttp(endpoint: string, fixturesPath: string, token: string | null): Promise<ReplayReport> {
  const url = withToken(endpoint, token);
  const files = await listFixtures(fixturesPath);
  if (files.length === 0) {
    throw new Error(`no fixtures found at ${fixturesPath}`);
  }
  const items: ReplayItem[] = [];
  for (const file of files) {
    const name = basename(file);
    try {
      const body = await readFixture(file);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      if (response.status === 422) {
        const fields = Array.isArray(record.fields) ? record.fields.map((item) => String(item)).join('; ') : 'validation_failed';
        items.push({ file: name, status: 'rejected', sale_id: '', resource_name: '', detail: fields });
        continue;
      }
      if (response.status !== 200 || record.ok !== true) {
        const errorName = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
        items.push({ file: name, status: 'error', sale_id: '', resource_name: '', detail: errorName });
        continue;
      }
      items.push({
        file: name,
        status: record.duplicate === true ? 'duplicate' : 'accepted',
        sale_id: typeof record.sale_id === 'string' ? record.sale_id : '',
        resource_name: typeof record.resource_name === 'string' ? record.resource_name : '',
        detail: typeof record.email_skipped_reason === 'string' ? record.email_skipped_reason : '',
      });
    } catch (error) {
      items.push({
        file: name,
        status: 'error',
        sale_id: '',
        resource_name: '',
        detail: error instanceof Error ? error.message : 'replay failed',
      });
    }
  }
  return tally(items);
}

export function formatReport(report: ReplayReport): string {
  const header = `${'fixture'.padEnd(36)} ${'status'.padEnd(12)} ${'sale_id'.padEnd(24)} resource`;
  const lines = report.items.map((item) => {
    return `${item.file.padEnd(36)} ${item.status.padEnd(12)} ${item.sale_id.padEnd(24)} ${item.resource_name}`;
  });
  const summary = `${report.accepted} accepted, ${report.duplicate} duplicate, ${report.rejected} rejected, ${report.error} error`;
  return [header, ...lines, summary].join('\n');
}
