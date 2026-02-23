# http-shell-for-gemini-cli

[English](README.md) | [中文](README_CN.md)

A fork of Google [Gemini CLI](https://github.com/google-gemini/gemini-cli) with a new `--http-server` mode that exposes Gemini CLI's authentication and model capabilities as an **OpenAI Chat Completion compatible** HTTP endpoint.

Any OpenAI-compatible client (OpenClaw, Cursor, or any OpenAI SDK) can use Gemini models by simply pointing the Base URL to this service. Supports **SSE streaming**, **non-streaming** responses, and **native Function Calling (tool_calls)**.

## Quick Start

### Prerequisites

- **Linux** (WSL or cloud server recommended)
- **Node.js ≥ 20**
- Gemini CLI OAuth authentication completed (`~/.gemini/oauth_creds.json` exists)

### Build & Run

```bash
cd gemini-cli
npm install
npm run build

# Start HTTP Server
node packages/cli/dist/index.js --http-server --http-port 9000
```

On successful startup, the console outputs:

```
[gemini-http] ====================================
[gemini-http]  Gemini CLI HTTP Server
[gemini-http]  OpenAI-compatible API at http://localhost:9000
[gemini-http]  Model: auto-gemini-3
[gemini-http] ====================================
```

### Send a Request

```bash
curl -s http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Introduce yourself in one sentence"}
    ]
  }' | python3 -m json.tool
```

Add `"stream": true` for SSE streaming.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Main endpoint, OpenAI Chat Completion compatible |
| `POST` | `/chat/completions` | Alias (for SDKs that omit `/v1` prefix) |
| `OPTIONS` | `*` | CORS preflight |

### Supported Request Fields

- `messages` — Message array, supports `system` / `user` / `assistant` / `tool` roles
- `stream` — Enable SSE streaming (default `false`)
- `tools` — Function calling tool declarations (OpenAI format, auto-converted to Gemini format)
- `model` — Model name (actual model is determined by CLI config; this field is for logging only)

### Response Format

Fully compatible with OpenAI Chat Completion response structure, including `choices[].message.tool_calls`.

## CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--http-server` | — | Enable HTTP Server mode (required) |
| `--http-port` | `9000` | Listen port |
| `--http-host` | `0.0.0.0` | Bind address |

## Logging

- **Console** (stderr): Request summaries, model resolution, timing
- **File** (`gemini-http.log`): Full request/response details, error stacks

## Usage with AI Tools

OpenClaw / Cursor / any OpenAI SDK client:

- **Base URL**: `http://<server-ip>:9000/v1`
- **API Key**: Any value (not validated)
- **Model**: `auto`

## Project Structure

```
http-shell-for-gemini-cli/
├── gemini-cli/                                  # Forked from official Gemini CLI
│   └── packages/cli/src/
│       ├── gemini.tsx                           # CLI entry, added --http-server branch
│       └── httpServer.ts                        # ★ HTTP Server core implementation
├── GEMINI.md                                    # AI developer documentation
└── README.md                                    # This file
```

## Stopping the Server

Press **Ctrl+C** to exit.

## Current Limitations

- Token usage stats are estimated values
- `temperature`, `max_tokens` and other sampling parameters are not passed through

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Kooooooma/http-shell-for-gemini-cli&type=Date)](https://star-history.com/#Kooooooma/http-shell-for-gemini-cli&Date)
