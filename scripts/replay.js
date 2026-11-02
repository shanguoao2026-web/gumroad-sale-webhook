#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'src', 'cli.js');

if (!existsSync(cli)) {
  console.error('Build the project first: npm run build');
  process.exit(1);
}

const child = spawn(process.execPath, [cli, 'replay', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
