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
- `logs scan`
- `logs diagnose`

## MCP Server

```bash
logs-mcp
```

6 tools available.

## HTTP mode

Run a shared Streamable HTTP MCP server (127.0.0.1 only):

```bash
logs-mcp --http               # default port 8820
logs-mcp --http --port 8820
MCP_HTTP=1 logs-mcp
```

- Health: `GET http://127.0.0.1:8820/health`
- MCP: `POST http://127.0.0.1:8820/mcp`

Stdio remains the default when no `--http` flag is passed.

## REST API

```bash
logs-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service logs
cloud sync pull --service logs
```

## Data Directory

Data is stored in `~/.hasna/logs/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
