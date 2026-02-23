# http-shell-for-gemini-cli

[English](README.md) | [中文](README_CN.md)

基于 Google [Gemini CLI](https://github.com/google-gemini/gemini-cli) 官方源码 fork 修改，新增了 `--http-server` 模式，将 Gemini CLI 的认证与模型调用能力暴露为 **OpenAI Chat Completion 兼容**的 HTTP 端点。

客户端（OpenClaw、Cursor、任意 OpenAI SDK）只需将 Base URL 指向本服务，即可透明使用 Gemini 模型，支持 **SSE 流式**与**非流式**两种响应模式，以及**原生 Function Calling（tool_calls）**。

## 快速启动

### 前置条件

- **Linux 系统**（推荐 WSL 或云服务器）
- **Node.js ≥ 20**
- Gemini CLI 已完成 OAuth 认证（`~/.gemini/oauth_creds.json` 存在）

### 构建 & 启动

```bash
cd gemini-cli
npm install
npm run build

# 启动 HTTP Server
node packages/cli/dist/index.js --http-server --http-port 9000
```

启动成功后控制台输出：

```
[gemini-http] ====================================
[gemini-http]  Gemini CLI HTTP Server
[gemini-http]  OpenAI-compatible API at http://localhost:9000
[gemini-http]  Model: auto-gemini-3
[gemini-http] ====================================
```

### 发送请求

```bash
curl -s http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "用一句话介绍你自己"}
    ]
  }' | python3 -m json.tool
```

流式请求加 `"stream": true` 即可获得 SSE 逐字推送。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/chat/completions` | 核心入口，兼容 OpenAI Chat Completion |
| `POST` | `/chat/completions` | 兼容别名（部分旧 SDK 不带 `/v1` 前缀） |
| `OPTIONS` | `*` | CORS 预检 |

### 支持的请求字段

- `messages` — 消息数组，支持 `system` / `user` / `assistant` / `tool` 角色
- `stream` — 是否启用 SSE 流式（默认 `false`）
- `tools` — Function Calling 工具声明（OpenAI 格式，自动转为 Gemini 格式）
- `model` — 模型名（实际使用 CLI 配置的模型，此字段仅做日志记录）

### 响应格式

完全兼容 OpenAI Chat Completion 响应结构，包括 `choices[].message.tool_calls` 字段。

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--http-server` | — | 启用 HTTP Server 模式（必需） |
| `--http-port` | `9000` | 监听端口 |
| `--http-host` | `0.0.0.0` | 绑定地址 |

## 日志系统

- **控制台**（stderr）：请求摘要、模型解析、耗时统计
- **文件**（`gemini-http.log`）：完整请求/响应详情、错误堆栈

## 在 AI 工具中使用

OpenClaw / Cursor / 任意 OpenAI SDK 客户端：

- **Base URL**: `http://<server-ip>:9000/v1`
- **API Key**: 任意值（不做校验）
- **Model**: `auto`

## 项目结构

```
http-shell-for-gemini-cli/
├── gemini-cli/                                  # 基于官方 Gemini CLI fork 修改
│   └── packages/cli/src/
│       ├── gemini.tsx                           # CLI 入口，新增 --http-server 分支
│       └── httpServer.ts                        # ★ HTTP Server 核心实现
├── GEMINI.md                                    # AI 开发者文档
└── README.md                                    # 本文件
```

## 停止服务

直接按 **Ctrl+C** 即可退出。

## 当前限制

- Token 统计（usage 字段）为估算值
- 不支持 `temperature`、`max_tokens` 等采样参数透传

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Kooooooma/http-shell-for-gemini-cli&type=Date)](https://star-history.com/#Kooooooma/http-shell-for-gemini-cli&Date)
