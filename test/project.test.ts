import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from './helpers.js';

describe('project contract', () => {
  it('ships the required docs and keeps runtime dependencies empty', async () => {
    const root = repoRoot();
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name?: string;
      private?: boolean;
      license?: string;
      engines?: { node?: string };
      dependencies?: Record<string, string>;
      scripts?: { test?: string };
    };
    assert.equal(pkg.name, 'gumroad-sale-webhook');
    assert.equal(pkg.private, true);
    assert.equal(pkg.license, 'MIT');
    assert.match(pkg.engines?.node ?? '', />=20/);
    assert.deepEqual(pkg.dependencies ?? {}, {});
    assert.match(pkg.scripts?.test ?? '', /node --enable-source-maps --test/);
    for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
      const text = await readFile(join(root, name), 'utf8');
      assert.ok(text.length > 40, name);
    }
    const license = await readFile(join(root, 'LICENSE'), 'utf8');
    assert.match(license, /MIT License/);
  });

  it('imports only node built-ins and local modules', async () => {
    const root = repoRoot();
    const files = await readdir(join(root, 'src'));
    const specifier = /from\s+['"]([^'"]+)['"]/g;
    let sawHttp = false;
    for (const file of files) {
      if (!file.endsWith('.ts')) {
        continue;
      }
      const text = await readFile(join(root, 'src', file), 'utf8');
      assert.doesNotMatch(text, /api\.gumroad\.com|nodemailer|better-sqlite3|sqlite3|express|fastify|axios/i);
      for (const match of text.matchAll(specifier)) {
        const source = match[1] ?? '';
        assert.match(source, /^(?:node:|\.{1,2}\/)/, `${file} imports ${source}`);
      }
      if (file === 'server.ts') {
        sawHttp = text.includes("from 'node:http'");
      }
    }
    assert.equal(sawHttp, true);
  });
});
