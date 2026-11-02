# gumroad-sale-webhook

Small local HTTP service for a digital-product seller. It accepts [Gumroad Ping](https://gumroad.com/ping) sale notifications, checks a secret in the query string, deduplicates them, appends a CSV ledger row, and renders a buyer email into an outbox folder.

It does not send mail, call the Gumroad API, or use SQLite. HTTP is implemented with Node's built-in `node:http` module.

## Requirements

- Node.js 20 or newer
- npm

Runtime dependencies: none. TypeScript is a development dependency used to compile the project.

## Quick start

```bash
npm install
npm test
npm run build
npm start -- --token "$(openssl rand -hex 24)" --port 8787
```

The process listens on `127.0.0.1` by default. Give Gumroad this Ping URL:

```text
https://your-host/gumroad/ping?token=YOUR_TOKEN
```

The token is the shared secret. Gumroad will append nothing on its own, so the secret has to be part of the URL you configure. Use 16 to 256 characters from this set: letters, digits, `.`, `_`, `~`, and `-`.

Try a fictional fixture against a running server:

```bash
curl -sS -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-binary @fixtures/01-sale-field-notes.form \
  'http://127.0.0.1:8787/gumroad/ping?token=YOUR_TOKEN'
```

## What a ping does

1. `POST /gumroad/ping?token=...` must be `application/x-www-form-urlencoded`. Bodies larger than 256 KiB are rejected.
2. Required fields are checked: `sale_id`, `email`, `product_name`, `price` (integer cents), and `seller_id`. `resource_name` must be `sale` or `refund`. When `resource_name` is omitted, `refunded=true` is treated as a refund and anything else as a sale.
3. The event is stored in `data/events.jsonl`. The dedupe key is `resource_name` plus `sale_id`, because Gumroad reuses `sale_id` when it notifies you about a refund.
4. A row is appended to `data/ledger.csv`. Refund rows store a negative `signed_cents`, so a spreadsheet sum of that column is the net of the pings you have accepted. `price` is the amount on the ping, in USD cents. It is not multiplied by `quantity`.
5. A sale renders `templates/sale.txt` into `data/outbox/sale--<sale_id>.eml`. A refund renders `templates/refund.txt` into `data/outbox/refund--<sale_id>.eml`. If a refund for that `sale_id` is already stored, or the sale ping itself has `refunded=true`, the welcome email is skipped and the ledger row records why.

A repeated delivery of the same key returns HTTP 200 with `"duplicate": true` and does not add another ledger row. Gumroad retries when the response is not successful, so duplicates have to be acknowledged.

`events.jsonl` is the source of truth. The CSV and the outbox are projections. On startup, and again when a duplicate ping arrives, any missing projection is written once more.

Refunds may arrive before the sale ping. Both are stored. The late sale still updates the ledger and does not render a welcome email.

Fields outside the allow-list are ignored. In particular, `license_key` and card details from the ping are not written to the JSONL file or the CSV.

## HTTP

| Request | Result |
| --- | --- |
| `GET /health` | `200` and `{ "ok": true, "service": "gumroad-sale-webhook", "version", "uptime_seconds", "events" }` |
| `POST /gumroad/ping?token=...` with a new valid ping | `200` and `"duplicate": false` |
| Same ping again | `200` and `"duplicate": true` |
| Missing or wrong token | `403` `{ "ok": false, "error": "forbidden" }` |
| Wrong content type | `415` |
| Invalid fields | `422` and a `fields` array |
| Body over 256 KiB | `413` |
| Other paths | `404` |

`GET /health` is not authenticated. It reports a count, not buyer details. Keep the bind address on localhost unless you put a proxy in front of it.

## CLI

```text
gumroad-sale-webhook serve [options]
gumroad-sale-webhook replay [options]
gumroad-sale-webhook --help
gumroad-sale-webhook --version
```

`gumroad-sale-webhook --help` lists every flag. Settings come from the flag, then the environment, then the default.

| Environment | Flag | Default |
| --- | --- | --- |
| `GUMROAD_PING_TOKEN` | `--token` | required for `serve` |
| `HOST` | `--host` | `127.0.0.1` |
| `PORT` | `--port` | `8787` (`0` chooses a free port) |
| `DATA_DIR` | `--data-dir` | `./data` |
| `TEMPLATES_DIR` | `--templates-dir` | `./templates` |
| `FROM_ADDRESS` | `--from` | `Northwind Press <ledger@example.com>` |

One process should own a data directory. The service serializes writes in that process. Two processes writing the same directory can corrupt the files.

## Replay fixtures

`fixtures/*.form` contains fictional Gumroad Ping bodies. Addresses use `example.com`. Nothing in this repository is a real buyer, seller, or license key.

```bash
npm run build
npm run replay -- --data-dir /tmp/gumroad-demo
node scripts/replay.js --data-dir /tmp/gumroad-demo
```

To post those fixtures at a server that is already running:

```bash
node scripts/replay.js --url http://127.0.0.1:8787/gumroad/ping --token YOUR_TOKEN
```

Replay reads only `*.form` files in the top directory you pass. `fixtures/invalid/` is not applied by a normal replay. The sample set is:

| File | What it covers |
| --- | --- |
| `01-sale-field-notes.form` | Paid sale, plus license and card fields that must be dropped |
| `02-sale-field-notes-retry.form` | Same `sale_id` sent again (`retry_count`) |
| `03-refund-field-notes.form` | Refund of that sale |
| `04-sale-free-checklist.form` | Zero-price product |
| `05-refund-lantern-first.form` | Refund that arrives before its sale |
| `06-sale-lantern-second.form` | The sale ping after that refund (no welcome email) |
| `07-test-ping.form` | `test=true`, quantity 2, fee omitted |

## Templates

`templates/sale.txt` and `templates/refund.txt` are plain-text messages. Placeholders look like `{{product_name}}`. Values are stripped of newlines before substitution so a name cannot add extra headers. Both default templates include the sentence "This message was not sent."

## Development

```bash
npm test
```

`npm test` compiles TypeScript, then runs `node --test`. The suite is offline and does not need an API key. Tests use Node's built-in `node:test` runner.

Project layout:

```text
src/            service, HTTP server, CLI, replay
templates/      sale and refund email templates
fixtures/       fictional ping bodies
scripts/replay.js
test/           node:test files
```

## Security notes

- The token lives in the Ping URL, so it can show up in Gumroad's settings and in your own access logs. Treat the URL like a password.
- Comparison of the token does not stop at the first mismatched character.
- Text cells in the CSV that start with `=`, `+`, `-`, `@`, or a tab are prefixed so a spreadsheet does not treat them as formulas. Integer columns, including negative refund amounts, stay numeric.
- Card data and license keys sent on the ping are discarded.
- This program never opens an SMTP connection.

## License

MIT. See [LICENSE](LICENSE).
