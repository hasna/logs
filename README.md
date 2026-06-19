# @hasna/logs

Log aggregation + browser script + headless page scanner + performance monitoring for AI agents

[![npm](https://img.shields.io/npm/v/@hasna/logs)](https://www.npmjs.com/package/@hasna/logs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/logs
```

## CLI Usage

```bash
logs --help
```

- `logs list`
- `logs tail`
- `logs summary`
- `logs push`
- `logs events`
- `logs test-reports`
- `logs scan`
- `logs diagnose`

## MCP Server

```bash
logs-mcp
```

Includes log search, raw event search/watch/export, projected test-report search/get, storage sync, scan, issue, and performance tools.

## HTTP mode

Run a shared Streamable HTTP MCP server (127.0.0.1 only):

```bash
logs-mcp --http               # default port 8864
logs-mcp --http --port 8864
MCP_HTTP=1 logs-mcp
```

- Health: `GET http://127.0.0.1:8864/health`
- MCP: `POST http://127.0.0.1:8864/mcp`

Stdio remains the default when no `--http` flag is passed.

## REST API

```bash
logs-serve
```

By default the API is locked unless an API token is configured or trusted
loopback mode is explicitly enabled:

```bash
HASNA_LOGS_API_TOKEN="$(openssl rand -hex 32)" logs-serve
# or, for local-only development:
logs-serve --local-open
```

Use `Authorization: Bearer <token>` or `X-Logs-Token: <token>` for `/api/*`
requests. Browser ingest tokens remain scoped write-only tokens for browser
capture and do not grant general API access.

Page scanner credentials are encrypted at rest with a generated local
`page-auth.key` under the logs data directory. For deployments that need a
managed secret, set `HASNA_LOGS_SECRET_KEY` or `LOGS_SECRET_KEY`:

```bash
export HASNA_LOGS_SECRET_KEY="$(openssl rand -hex 32)"
```

## Remote Sync

Logs stores data locally in SQLite and can optionally push/pull service-owned tables to PostgreSQL, including AWS RDS:

Configure `HASNA_LOGS_DATABASE_URL` or `LOGS_DATABASE_URL`, then use `logs storage status`, `logs storage push`, `logs storage pull`, or `logs storage sync`.

The MCP server also exposes `storage_status`, `storage_push`, `storage_pull`, and `storage_sync`.

`LOGS_DATABASE_URL` is accepted as the non-Hasna fallback database URL.

## Data Directory

Data is stored in `~/.hasna/logs/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
