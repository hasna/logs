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
