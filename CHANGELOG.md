# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [1.0.0] - 2026-11-02

### Added

- HTTP service that accepts Gumroad Ping bodies (`application/x-www-form-urlencoded`) at `POST /gumroad/ping`.
- Shared-secret query parameter `token` checked with a constant-time compare.
- Field validation for sale and refund pings, including out-of-order refunds.
- JSON Lines event store deduplicated on `resource_name` and `sale_id`.
- Append-only CSV ledger with a negative `signed_cents` amount on refund rows.
- Plain-text welcome and refund emails rendered into an outbox. Mail is never sent.
- `GET /health`.
- `serve` and `replay` CLI commands, plus `scripts/replay.js`.
- Fictional fixtures under `fixtures/` and an offline `node:test` suite.
