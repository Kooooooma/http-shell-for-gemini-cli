/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP Server mode for Gemini CLI.
 *
 * Exposes an OpenAI-compatible chat completions API that uses the
 * authenticated Gemini CLI backend. Supports streaming (SSE),
 * non-streaming responses, and native function calling (tool_calls).
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
    GenerateContentResponse,
    Content,
    Part,
    Tool,
    FunctionDeclaration,
} from '@google/genai';
import type { Config } from '@google/gemini-cli-core';
import { LlmRole, resolveModel } from '@google/gemini-cli-core';

// ---------------------------------------------------------------------------
// Logging – console (summary) + file (detailed)
// ---------------------------------------------------------------------------

let logFd: number | null = null;

function initLogFile(logPath: string) {
    logFd = fs.openSync(logPath, 'a');
    consoleLog(`Log file: ${logPath}`);
}

/** Console summary log – direct fd write bypasses patchStdio() in gemini.tsx */
function consoleLog(msg: string) {
    fs.writeSync(2, `[gemini-http] ${msg}\n`);
}

/** Detailed file log with timestamp */
function fileLog(label: string, data: unknown) {
    if (logFd === null) return;
    const timestamp = new Date().toISOString();
    const line = typeof data === 'string'
        ? `[${timestamp}] [${label}] ${data}\n`
        : `[${timestamp}] [${label}] ${JSON.stringify(data, null, 2)}\n`;
    fs.writeSync(logFd, line);
}

/** Log to both console (summary) and file (detailed) */
function log(label: string, summary: string, detail?: unknown) {
    consoleLog(`[${label}] ${summary}`);
    fileLog(label, detail ?? summary);
}

// ---------------------------------------------------------------------------
// Types – OpenAI Chat Completions
// ---------------------------------------------------------------------------

interface OpenAIContentPart {
    type: string;
    text?: string;
    image_url?: { url: string };
}

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | OpenAIContentPart[] | null;
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
}

/** Extract plain text from content that may be string or ContentPart[] */
function extractTextContent(content: string | OpenAIContentPart[] | null | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === 'text' && p.text)
            .map(p => p.text!)
            .join('\n');
    }
    return '';
}

interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface OpenAIToolDef {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

interface OpenAIChatRequest {
    model?: string;
    messages: OpenAIMessage[];
    tools?: OpenAIToolDef[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
}

// ---------------------------------------------------------------------------
// Conversion helpers – OpenAI ↔ Gemini
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI messages array to Gemini Content[].
 * Returns { systemInstruction, contents }.
 */
function convertMessages(messages: OpenAIMessage[]): {
    systemInstruction: string | undefined;
    contents: Content[];
} {
    let systemInstruction: string | undefined;
    const contents: Content[] = [];

    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                toolCallIdToName.set(tc.id, tc.function.name);
            }
        }
    }

    let pendingToolResponses: Part[] = [];

    const flushToolResponses = () => {
        if (pendingToolResponses.length > 0) {
            contents.push({ role: 'user', parts: pendingToolResponses });
            pendingToolResponses = [];
        }
    };

    for (const msg of messages) {
        if (msg.role === 'system') {
            flushToolResponses();
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${extractTextContent(msg.content)}`
                : extractTextContent(msg.content);
            continue;
        }

        if (msg.role === 'user') {
            flushToolResponses();
            contents.push({
                role: 'user',
                parts: [{ text: extractTextContent(msg.content) }],
            });
            continue;
        }

        if (msg.role === 'assistant') {
            flushToolResponses();
            const parts: Part[] = [];

            if (extractTextContent(msg.content)) {
                parts.push({ text: extractTextContent(msg.content) });
            }

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(tc.function.arguments) as Record<
                            string,
                            unknown
                        >;
                    } catch {
                        args = { raw: tc.function.arguments };
                    }
                    parts.push({
                        functionCall: {
                            name: tc.function.name,
                            args,
                        },
                    });
                }
            }

            if (parts.length > 0) {
                contents.push({ role: 'model', parts });
            }
            continue;
        }

        if (msg.role === 'tool') {
            const funcName =
                msg.name ??
                (msg.tool_call_id
                    ? toolCallIdToName.get(msg.tool_call_id)
                    : undefined) ??
                'unknown';

            pendingToolResponses.push({
                functionResponse: {
                    name: funcName,
                    response: {
                        content: extractTextContent(msg.content),
                    },
                },
            });
            continue;
        }
    }

    flushToolResponses();
    return { systemInstruction, contents };
}

/**
 * Convert OpenAI tool definitions to Gemini FunctionDeclaration[].
 */
function convertTools(tools: OpenAIToolDef[]): Tool[] {
    const declarations: FunctionDeclaration[] = tools
        .filter((t) => t.type === 'function')
        .map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as FunctionDeclaration['parameters'],
        }));

    if (declarations.length === 0) return [];
    return [{ functionDeclarations: declarations }];
}

/**
 * Extract text and function calls from a Gemini response.
 */
function extractResponseParts(response: GenerateContentResponse): {
    text: string;
    functionCalls: OpenAIToolCall[];
} {
    let text = '';
    const functionCalls: OpenAIToolCall[] = [];

    const candidates = response.candidates ?? [];
    for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
            if ('text' in part && part.text) {
                text += part.text;
            }
            if ('functionCall' in part && part.functionCall) {
                functionCalls.push({
                    id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name ?? 'unknown',
                        arguments: JSON.stringify(part.functionCall.args ?? {}),
                    },
                });
            }
        }
    }

    return { text, functionCalls };
}

// ---------------------------------------------------------------------------
// OpenAI response builders
// ---------------------------------------------------------------------------

function buildCompletionResponse(
    model: string,
    text: string,
    finishReason: string,
    toolCalls?: OpenAIToolCall[],
) {
    return {
        id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: toolCalls && toolCalls.length > 0 ? null : text,
                    ...(toolCalls && toolCalls.length > 0
                        ? { tool_calls: toolCalls }
                        : {}),
                },
                finish_reason: finishReason,
            },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

function buildStreamChunk(
    chunkId: string,
    model: string,
    options: {
        role?: string;
        content?: string | null;
        toolCalls?: OpenAIToolCall[];
        finishReason?: string | null;
    },
) {
    const delta: Record<string, unknown> = {};
    if (options.role !== undefined) delta['role'] = options.role;
    if (options.content !== undefined) delta['content'] = options.content;
    if (options.toolCalls !== undefined) delta['tool_calls'] = options.toolCalls;

    return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                delta,
                finish_reason: options.finishReason ?? null,
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

function sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown,
) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function sendSSE(res: http.ServerResponse, data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCorsHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleChatCompletion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: Config,
) {
    const startTime = Date.now();
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    const requestId = randomUUID().slice(0, 8);

    const body = await readBody(req);
    let request: OpenAIChatRequest;
    try {
        request = JSON.parse(body) as OpenAIChatRequest;
    } catch {
        log('REQUEST', `[${requestId}] ${clientIp} - Invalid JSON body`);
        sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
        return;
    }
    const rawModel = config.getModel();
    const model = resolveModel(rawModel);
    consoleLog(`[${requestId}] Model: raw="${rawModel}" → resolved="${model}"`);
    fileLog('MODEL', { requestId, rawModel, resolvedModel: model });
    const streamMode = request.stream ? 'stream' : 'non-stream';
    const toolCount = request.tools?.length ?? 0;
    const toolNames = request.tools?.map(t => t.function.name).join(', ') ?? '';

    // Console summary
    consoleLog(`[${requestId}] ${clientIp} | ${streamMode} | msgs=${request.messages.length} tools=${toolCount}`);

    // Detailed file log – full request
    fileLog('REQUEST', {
        requestId,
        clientIp,
        stream: request.stream,
        model: request.model,
        messageCount: request.messages.length,
        toolCount,
        toolNames: toolNames || undefined,
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        top_p: request.top_p,
    });

    const { systemInstruction, contents } = convertMessages(request.messages);
    const tools = request.tools ? convertTools(request.tools) : [];

    const contentGenerator = config.getContentGenerator();
    if (!contentGenerator) {
        log('ERROR', `[${requestId}] Content generator not initialized`);
        sendJson(res, 500, {
            error: { message: 'Content generator not initialized' },
        });
        return;
    }

    try {
        if (request.stream) {
            // ----- Streaming response -----
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });

            const chunkId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

            sendSSE(res, buildStreamChunk(chunkId, model, { role: 'assistant' }));

            const stream = await contentGenerator.generateContentStream(
                {
                    model,
                    contents,
                    config: {
                        systemInstruction: systemInstruction
                            ? { parts: [{ text: systemInstruction }] }
                            : undefined,
                        tools: tools.length > 0 ? tools : undefined,
                        temperature: request.temperature,
                        maxOutputTokens: request.max_tokens,
                        topP: request.top_p,
                    },
                },
                'http-server',
                LlmRole.MAIN,
            );

            let hasToolCalls = false;
            const collectedToolCalls: OpenAIToolCall[] = [];
            let fullText = '';

            for await (const chunk of stream) {
                const { text, functionCalls } = extractResponseParts(chunk);

                if (text) {
                    fullText += text;
                    sendSSE(res, buildStreamChunk(chunkId, model, { content: text }));
                }

                if (functionCalls.length > 0) {
                    hasToolCalls = true;
                    collectedToolCalls.push(...functionCalls);
                }
            }

            if (hasToolCalls) {
                sendSSE(
                    res,
                    buildStreamChunk(chunkId, model, {
                        toolCalls: collectedToolCalls,
                        finishReason: 'tool_calls',
                    }),
                );
            } else {
                sendSSE(
                    res,
                    buildStreamChunk(chunkId, model, { finishReason: 'stop' }),
                );
            }

            res.write('data: [DONE]\n\n');
            res.end();

            const elapsed = Date.now() - startTime;
            const finishReason = hasToolCalls ? 'tool_calls' : 'stop';

            // Console summary
            consoleLog(`[${requestId}] Done ${elapsed}ms | ${finishReason} | text=${fullText.length}ch tool_calls=${collectedToolCalls.length}`);

            // Detailed file log – full response
            fileLog('RESPONSE', {
                requestId,
                elapsed: `${elapsed}ms`,
                stream: true,
                finishReason,
                textLength: fullText.length,
                text: fullText || undefined,
                toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
            });

        } else {
            // ----- Non-streaming response -----
            const response = await contentGenerator.generateContent(
                {
                    model,
                    contents,
                    config: {
                        systemInstruction: systemInstruction
                            ? { parts: [{ text: systemInstruction }] }
                            : undefined,
                        tools: tools.length > 0 ? tools : undefined,
                        temperature: request.temperature,
                        maxOutputTokens: request.max_tokens,
                        topP: request.top_p,
                    },
                },
                'http-server',
                LlmRole.MAIN,
            );

            const { text, functionCalls } = extractResponseParts(response);
            const elapsed = Date.now() - startTime;

            if (functionCalls.length > 0) {
                sendJson(
                    res,
                    200,
                    buildCompletionResponse(model, '', 'tool_calls', functionCalls),
                );
            } else {
                sendJson(res, 200, buildCompletionResponse(model, text, 'stop'));
            }

            const finishReason = functionCalls.length > 0 ? 'tool_calls' : 'stop';

            // Console summary
            consoleLog(`[${requestId}] Done ${elapsed}ms | ${finishReason} | text=${text.length}ch tool_calls=${functionCalls.length}`);

            // Detailed file log – full response
            fileLog('RESPONSE', {
                requestId,
                elapsed: `${elapsed}ms`,
                stream: false,
                finishReason,
                textLength: text.length,
                text: text || undefined,
                toolCalls: functionCalls.length > 0 ? functionCalls : undefined,
            });
        }
    } catch (error) {
        const elapsed = Date.now() - startTime;
        const message =
            error instanceof Error ? error.message : 'Unknown error occurred';
        const stack = error instanceof Error ? error.stack : undefined;

        // Console summary
        consoleLog(`[${requestId}] ERROR ${elapsed}ms | ${message}`);

        // Detailed file log – error
        fileLog('ERROR', {
            requestId,
            elapsed: `${elapsed}ms`,
            message,
            stack,
        });

        if (!res.headersSent) {
            sendJson(res, 500, { error: { message } });
        } else {
            try {
                sendSSE(res, { error: { message } });
                res.write('data: [DONE]\n\n');
                res.end();
            } catch {
                res.end();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

export interface HttpServerOptions {
    port: number;
    host: string;
}

export async function runHttpServer(
    config: Config,
    options: HttpServerOptions,
): Promise<void> {
    const { port, host } = options;

    // Initialize log file in cwd
    const logPath = path.join(process.cwd(), 'gemini-http.log');
    initLogFile(logPath);

    const server = http.createServer(
        async (req: http.IncomingMessage, res: http.ServerResponse) => {
            setCorsHeaders(res);

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const url = req.url ?? '';

            if (
                req.method === 'POST' &&
                (url === '/v1/chat/completions' || url === '/chat/completions')
            ) {
                await handleChatCompletion(req, res, config);
                return;
            }


            sendJson(res, 404, { error: { message: 'Not found' } });
        },
    );

    return new Promise((resolve) => {
        server.listen(port, host, () => {
            const address = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
            consoleLog('====================================');
            consoleLog(' Gemini CLI HTTP Server');
            consoleLog(` OpenAI-compatible API at ${address}`);
            consoleLog(` Model: ${config.getModel()}`);
            consoleLog('====================================');

            fileLog('MAIN', {
                event: 'server_started',
                address,
                model: config.getModel(),
                port,
                host,
            });
        });

        // ---- Robust shutdown ----
        const forceShutdown = (signal: string) => {
            consoleLog(`Shutting down... (${signal})`);
            fileLog('MAIN', `Server shutting down (${signal})`);
            try { server.close(); } catch { }
            // Force exit immediately - don't wait for graceful close
            process.exit(0);
        };

        // Remove ALL other SIGINT/SIGTERM listeners that might block exit
        // (e.g. from Ink, React, or other CLI subsystems)
        const cleanupAndRegister = () => {
            const intCount = process.listenerCount('SIGINT');
            const termCount = process.listenerCount('SIGTERM');
            if (intCount > 1 || termCount > 1) {
                consoleLog(`Cleaning up signal listeners: SIGINT=${intCount} SIGTERM=${termCount}`);
            }
            process.removeAllListeners('SIGINT');
            process.removeAllListeners('SIGTERM');
            process.on('SIGINT', () => forceShutdown('SIGINT'));
            process.on('SIGTERM', () => forceShutdown('SIGTERM'));
        };

        consoleLog(`Signal listeners before cleanup: SIGINT=${process.listenerCount('SIGINT')} SIGTERM=${process.listenerCount('SIGTERM')}`);
        cleanupAndRegister();

        // Re-clean periodically in case other subsystems re-register handlers
        setInterval(cleanupAndRegister, 5000).unref();

        // FALLBACK: Listen on stdin for Ctrl+C byte (0x03) directly.
        // This works even when SIGINT delivery is broken by patchStdio() or
        // other terminal manipulation in the CLI.
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.on('data', (data: Buffer) => {
                    if (data.length > 0 && data[0] === 0x03) { // Ctrl+C
                        forceShutdown('CTRL+C-stdin');
                    }
                });
                consoleLog('Stdin raw-mode Ctrl+C handler active');
            } catch (e) {
                consoleLog(`Stdin raw-mode not available: ${e}`);
            }
        } else {
            consoleLog('Not a TTY, stdin Ctrl+C handler skipped');
        }
    });
}

