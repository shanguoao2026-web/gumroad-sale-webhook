#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FROM,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVICE_NAME,
  fromError,
  hostError,
  portError,
  tokenError,
} from './limits.js';
import { consoleLogger } from './logger.js';
import { exitCodeForReport, formatReport, replayHttp, replayLocal } from './replay.js';
import { PingService } from './service.js';
import { startServer } from './server.js';
import { readPackageVersion } from './version.js';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type ServeCommand = {
  kind: 'serve';
  host: string;
  port: number;
  token: string;
  dataDir: string;
  templatesDir: string;
  from: string;
};

export type ReplayCommand = {
  kind: 'replay';
  fixtures: string;
  dataDir: string;
  templatesDir: string;
  from: string;
  url: string | null;
  token: string | null;
};

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | ServeCommand
  | ReplayCommand;

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; message: string };

const SERVE_FLAGS = new Set(['--host', '--port', '--token', '--data-dir', '--templates-dir', '--from']);
const REPLAY_FLAGS = new Set(['--fixtures', '--data-dir', '--templates-dir', '--from', '--url', '--token']);

export function helpText(): string {
  return `${SERVICE_NAME} — store Gumroad Ping sales on this machine

Usage:
  ${SERVICE_NAME} serve [options]
  ${SERVICE_NAME} replay [options]
  ${SERVICE_NAME} --help
  ${SERVICE_NAME} --version

Commands:
  serve     Listen for POST /gumroad/ping and GET /health
  replay    Apply fixture ping bodies locally, or POST them with --url

Serve options:
  --host <addr>           Bind address (default: ${DEFAULT_HOST}, env HOST)
  --port <n>              Bind port (default: ${DEFAULT_PORT}, env PORT). 0 picks a free port
  --token <secret>        Query secret buyers of this URL must present (env GUMROAD_PING_TOKEN)
  --data-dir <path>       JSONL store, CSV ledger, and outbox (default: ./data, env DATA_DIR)
  --templates-dir <path>  Email templates (default: ./templates, env TEMPLATES_DIR)
  --from <addr>           From header on rendered mail (env FROM_ADDRESS)

Replay options:
  --fixtures <path>       Directory of *.form bodies, or one .form file (default: ./fixtures)
  --data-dir <path>       Used for local replay
  --templates-dir <path>
  --from <addr>
  --url <endpoint>        POST fixtures to a running service instead of writing locally
  --token <secret>        Appended as ?token= when --url has no token

Point Gumroad's Ping URL at:
  https://your-host/gumroad/ping?token=YOUR_TOKEN

The same sale_id can arrive again, and a refund reuses that sale_id with
resource_name=refund. Duplicates of the same sale_id and resource_name return
HTTP 200 and do not add a second ledger row. Rendered mail is written under
the outbox directory and is never sent.

Precedence for each setting is the command flag, then the environment variable, then the default.
`;
}

function takeValue(
  args: readonly string[],
  index: number,
  flag: string,
): { ok: true; value: string; next: number } | { ok: false; message: string } {
  const current = args[index];
  if (current === undefined) {
    return { ok: false, message: `${flag} requires a value` };
  }
  const equals = current.indexOf('=');
  if (equals !== -1) {
    return { ok: true, value: current.slice(equals + 1), next: index + 1 };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    return { ok: false, message: `${flag} requires a value` };
  }
  return { ok: true, value: next, next: index + 2 };
}

export function parseArgs(argv: readonly string[], ctx: CliContext): ParseResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { ok: true, command: { kind: 'help' } };
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    return { ok: true, command: { kind: 'version' } };
  }
  const commandName = argv[0];
  if (!commandName) {
    return { ok: false, message: 'missing command' };
  }
  if (commandName !== 'serve' && commandName !== 'replay') {
    return { ok: false, message: `unknown command ${commandName}` };
  }
  const allowed = commandName === 'serve' ? SERVE_FLAGS : REPLAY_FLAGS;
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; ) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith('--')) {
      return { ok: false, message: `unexpected argument ${token}` };
    }
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!allowed.has(flag)) {
      return { ok: false, message: `unknown option ${flag}` };
    }
    const taken = takeValue(argv, index, flag);
    if (!taken.ok) {
      return taken;
    }
    values.set(flag, taken.value);
    index = taken.next;
  }

  const dataDir = resolve(ctx.cwd, values.get('--data-dir') ?? ctx.env.DATA_DIR ?? 'data');
  const templatesDir = resolve(ctx.cwd, values.get('--templates-dir') ?? ctx.env.TEMPLATES_DIR ?? 'templates');
  const fromRaw = (values.get('--from') ?? ctx.env.FROM_ADDRESS ?? DEFAULT_FROM).trim();
  const fromProblem = fromError(fromRaw);
  if (fromProblem) {
    return { ok: false, message: fromProblem };
  }

  if (commandName === 'serve') {
    const host = values.get('--host') ?? ctx.env.HOST ?? DEFAULT_HOST;
    const hostProblem = hostError(host);
    if (hostProblem) {
      return { ok: false, message: hostProblem };
    }
    const portRaw = values.get('--port') ?? ctx.env.PORT ?? String(DEFAULT_PORT);
    const portProblem = portError(portRaw);
    if (portProblem) {
      return { ok: false, message: portProblem };
    }
    const token = values.get('--token') ?? ctx.env.GUMROAD_PING_TOKEN ?? '';
    if (!token) {
      return { ok: false, message: 'serve requires --token or GUMROAD_PING_TOKEN' };
    }
    const tokenProblem = tokenError(token);
    if (tokenProblem) {
      return { ok: false, message: tokenProblem };
    }
    return {
      ok: true,
      command: {
        kind: 'serve',
        host,
        port: Number(portRaw),
        token,
        dataDir,
        templatesDir,
        from: fromRaw,
      },
    };
  }

  const url = values.get('--url') ?? null;
  const tokenFlag = values.get('--token') ?? null;
  let token: string | null = tokenFlag;
  if (!token && url) {
    token = ctx.env.GUMROAD_PING_TOKEN ?? null;
  }
  if (token) {
    const tokenProblem = tokenError(token);
    if (tokenProblem) {
      return { ok: false, message: tokenProblem };
    }
  }
  return {
    ok: true,
    command: {
      kind: 'replay',
      fixtures: resolve(ctx.cwd, values.get('--fixtures') ?? 'fixtures'),
      dataDir,
      templatesDir,
      from: fromRaw,
      url,
      token,
    },
  };
}

async function runServe(command: ServeCommand): Promise<number> {
  const service = new PingService({
    dataDir: command.dataDir,
    templatesDir: command.templatesDir,
    from: command.from,
  });
  await service.init();
  const running = await startServer({
    host: command.host,
    port: command.port,
    token: command.token,
    service,
    logger: consoleLogger,
  });
  console.log(`${SERVICE_NAME} ${readPackageVersion()}`);
  console.log(`listening on http://${running.host}:${running.port}`);
  console.log('POST /gumroad/ping?token=<redacted>');
  console.log('GET  /health');
  console.log(`data directory: ${command.dataDir}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void running.close().then(() => resolve(), () => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function runReplay(command: ReplayCommand): Promise<number> {
  const report = command.url
    ? await replayHttp(command.url, command.fixtures, command.token)
    : await replayInto(command);
  console.log(formatReport(report));
  return exitCodeForReport(report);
}

async function replayInto(command: ReplayCommand) {
  const service = new PingService({
    dataDir: command.dataDir,
    templatesDir: command.templatesDir,
    from: command.from,
  });
  await service.init();
  return replayLocal(service, command.fixtures);
}

export async function main(argv: readonly string[], ctx: CliContext = { env: process.env, cwd: process.cwd() }): Promise<number> {
  const parsed = parseArgs(argv, ctx);
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(`Run '${SERVICE_NAME} --help' for usage.`);
    return 1;
  }
  if (parsed.command.kind === 'help') {
    console.log(helpText());
    return 0;
  }
  if (parsed.command.kind === 'version') {
    console.log(`${SERVICE_NAME} ${readPackageVersion()}`);
    return 0;
  }
  if (parsed.command.kind === 'serve') {
    return runServe(parsed.command);
  }
  return runReplay(parsed.command);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
