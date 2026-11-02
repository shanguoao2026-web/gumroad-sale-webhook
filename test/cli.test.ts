import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it } from 'node:test';
import { helpText, parseArgs } from '../src/cli.js';
import { DEFAULT_FROM } from '../src/limits.js';
import { cliPath, fixturesDir, makeTempDir, removeTemp, repoRoot, TOKEN } from './helpers.js';

function ctx(env: NodeJS.ProcessEnv = {}, cwd = '/tmp/gumroad-cwd') {
  return { env, cwd };
}

describe('parseArgs', () => {
  it('reads serve flags, environment variables, and equals form', () => {
    const fromFlags = parseArgs(
      ['serve', '--port', '0', '--token', TOKEN, '--host=127.0.0.1'],
      ctx(),
    );
    assert.equal(fromFlags.ok, true);
    if (!fromFlags.ok || fromFlags.command.kind !== 'serve') {
      return;
    }
    assert.equal(fromFlags.command.port, 0);
    assert.equal(fromFlags.command.token, TOKEN);
    assert.equal(fromFlags.command.host, '127.0.0.1');
    assert.equal(fromFlags.command.from, DEFAULT_FROM);

    const fromEnv = parseArgs(['serve'], ctx({ GUMROAD_PING_TOKEN: TOKEN, PORT: '8791' }));
    assert.equal(fromEnv.ok, true);
    if (!fromEnv.ok || fromEnv.command.kind !== 'serve') {
      return;
    }
    assert.equal(fromEnv.command.port, 8791);
    assert.equal(fromEnv.command.token, TOKEN);
  });

  it('rejects a missing command, a short token, an unknown flag, and a bad port', () => {
    assert.equal(parseArgs([], ctx()).ok, false);
    const missing = parseArgs(['serve'], ctx());
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.message, /token/);
    }
    const shortToken = parseArgs(['serve', '--token', 'short-token'], ctx());
    assert.equal(shortToken.ok, false);
    const unknown = parseArgs(['serve', '--token', TOKEN, '--nope', '1'], ctx());
    assert.equal(unknown.ok, false);
    const badPort = parseArgs(['serve', '--token', TOKEN, '--port', 'nope'], ctx());
    assert.equal(badPort.ok, false);
    const help = parseArgs(['serve', '--help'], ctx());
    assert.equal(help.ok, true);
    if (help.ok) {
      assert.equal(help.command.kind, 'help');
    }
  });

  it('builds a local replay without requiring a token', () => {
    const parsed = parseArgs(['replay', '--fixtures', 'fixtures/01-sale-field-notes.form'], ctx());
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.command.kind !== 'replay') {
      return;
    }
    assert.equal(parsed.command.url, null);
    assert.equal(parsed.command.token, null);
    assert.equal(parsed.command.fixtures.endsWith('01-sale-field-notes.form'), true);
  });
});

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      cwd: repoRoot(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out running cli ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function waitForListen(child: ChildProcess, stderr: { current: string }): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) {
    return Promise.reject(new Error('missing stdout'));
  }
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for listen\n${buffer}\n${stderr.current}`));
    }, 8000);
    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited early (${code ?? 'null'})\n${buffer}\n${stderr.current}`));
    });
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (!settled && /listening on http:\/\/127\.0\.0\.1:\d+/.test(buffer)) {
        settled = true;
        clearTimeout(timer);
        resolve(buffer);
      }
    });
  });
}

describe('cli process', () => {
  it('prints help and version', async () => {
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /POST \/gumroad\/ping/);
    assert.match(help.stdout, /never sent/);
    assert.match(help.stdout, /replay/);
    assert.equal(help.stdout.trim(), helpText().trim());

    const version = await run(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^gumroad-sale-webhook \d+\.\d+\.\d+\n$/);
  });

  it('fails closed when serve has no token', async () => {
    const result = await run(['serve'], { GUMROAD_PING_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /token/);
  });

  it('serves health on an ephemeral port and stops on SIGTERM', async () => {
    const dir = await makeTempDir();
    const child = spawn(
      process.execPath,
      [cliPath(), 'serve', '--port', '0', '--token', TOKEN, '--data-dir', dir, '--templates-dir', 'templates'],
      { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const stderr = { current: '' };
    child.stderr.on('data', (chunk: string) => {
      stderr.current += chunk;
    });
    try {
      const banner = await waitForListen(child, stderr);
      assert.equal(banner.includes(TOKEN), false);
      const match = banner.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const port = match?.[1];
      assert.ok(port);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true);
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not exit\n${stderr.current}`)), 5000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await removeTemp(dir);
    }
  });

  it('replays fixtures through the cli and the replay script', async () => {
    const dir = await makeTempDir();
    const other = await makeTempDir();
    try {
      const result = await run(['replay', '--fixtures', fixturesDir(), '--data-dir', dir]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /6 accepted, 1 duplicate, 0 rejected, 0 error/);

      const invalid = await run(['replay', '--fixtures', `${fixturesDir()}/invalid/missing-sale-id.form`, '--data-dir', dir]);
      assert.equal(invalid.code, 1);
      assert.match(invalid.stdout, /rejected/);

      const script = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/replay.js', '--fixtures', fixturesDir(), '--data-dir', other], {
          cwd: repoRoot(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`replay script timed out\n${stdout}\n${stderr}`));
        }, 8000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
      assert.equal(script.code, 0, script.stderr);
      assert.match(script.stdout, /6 accepted/);
    } finally {
      await removeTemp(dir);
      await removeTemp(other);
    }
  });
});
