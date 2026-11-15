// Anthropic Messages API bridge.
// Converts Anthropic-format requests to OpenAI-format for upstream providers,
// and converts OpenAI responses/SSE back to Anthropic format.

import type { Response } from 'express';
import type { ChatRequest } from './types.js';

// ---------- Anthropic wire types ----------

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: 'text';
  text?: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown; // string or array of content blocks
  is_error?: boolean;
}

type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

type AnthropicContent = string | AnthropicBlock[];

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text: string }>;
  messages?: Array<{ role: string; content: AnthropicContent }>;
  stream?: boolean;
  temperature?: number;
  tools?: AnthropicTool[];
}

function isToolUseBlock(b: AnthropicBlock): b is AnthropicToolUseBlock {
  return b.type === 'tool_use';
}

function isToolResultBlock(b: AnthropicBlock): b is AnthropicToolResultBlock {
  return b.type === 'tool_result';
}

// Anthropic tool_result.content -> string for OpenAI tool message
function toolResultToString(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

// ---------- Request conversion ----------

export function anthropicToChatReq(body: AnthropicRequest): ChatRequest {
  const messages: ChatRequest['messages'] = [];

  if (body.system) {
    const sys = typeof body.system === 'string' ? body.system : body.system.map((b) => b.text).join('\n');
    messages.push({ role: 'system', content: sys });
  }

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks: AnthropicBlock[] = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text ?? '')
      .filter((t) => t.length > 0)
      .join('\n');
    const toolUses = blocks.filter(isToolUseBlock);
    const toolResults = blocks.filter(isToolResultBlock);

    if (toolUses.length > 0) {
      // assistant message: text first, then tool_calls
      messages.push({
        role: 'assistant',
        content: text,
        tool_calls: toolUses.map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          },
        })),
      });
    } else if (text.length > 0) {
      messages.push({ role: msg.role, content: text });
    }

    // tool_result blocks become one OpenAI tool message per tool_use_id
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: toolResultToString(tr.content),
      });
    }
  }

  const tools = body.tools?.length
    ? body.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
      }))
    : undefined;

  return {
    model: body.model ?? 'auto',
    messages,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream ?? false,
    ...(tools ? { tools } : {}),
  };
}

// ---------- Non-streaming response conversion ----------

export function openaiToAnthropic(openai: {
  id: string;
  model: string;
  content: string;
  tokensUsed: number;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (openai.content) {
    content.push({ type: 'text', text: openai.content });
  }
  for (const tc of openai.toolCalls ?? []) {
    let input: unknown = {};
    try {
      input = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  return {
    id: openai.id,
    type: 'message',
    role: 'assistant',
    content,
    model: openai.model,
    stop_reason: (openai.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: openai.tokensUsed },
    // gateway extras (ignored by standard clients)
    gateway_provider: openai.model,
  };
}

export function anthropicError(res: Response, status: number, message: string): void {
  res.status(status).json({
    type: 'error',
    error: { type: status === 401 ? 'authentication_error' : 'api_error', message },
  });
}

// ---------- Streaming conversion ----------
// Upstream emits OpenAI SSE chunks; we emit Anthropic SSE events.

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolAccum {
  id: string;
  name: string;
  args: string;
  blockIndex: number; // anthropic content block index = upstream tool index + 1 (text is 0)
  started: boolean;
}

export function startAnthropicStream(
  res: Response,
  upstream: NodeJS.ReadableStream,
  msgId: string,
  model: string
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  let outputTokens = 0;
  let sawToolUse = false;
  let buffer = '';
  const toolAccs = new Map<number, ToolAccum>();

  const handleToolFragment = (tc: OpenAIToolCallDelta): void => {
    const upIdx = typeof tc?.index === 'number' ? tc.index : 0;
    let acc = toolAccs.get(upIdx);
    if (!acc) {
      acc = { id: '', name: '', args: '', blockIndex: upIdx + 1, started: false };
      toolAccs.set(upIdx, acc);
    }
    if (!acc.started) {
      // first fragment of this tool index: open its content block
      acc.started = true;
      if (typeof tc.id === 'string') acc.id = tc.id;
      if (typeof tc.function?.name === 'string') acc.name = tc.function.name;
      send({
        type: 'content_block_start',
        index: acc.blockIndex,
        content_block: { type: 'tool_use', id: acc.id, name: acc.name, input: {} },
      });
    } else {
      if (!acc.id && typeof tc.id === 'string') acc.id = tc.id;
      if (!acc.name && typeof tc.function?.name === 'string') acc.name = tc.function.name;
    }
    const frag = tc.function?.arguments;
    if (typeof frag === 'string' && frag.length > 0) {
      acc.args += frag;
      send({
        type: 'content_block_delta',
        index: acc.blockIndex,
        delta: { type: 'input_json_delta', partial_json: frag },
      });
    }
  };

  upstream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        const text: string | undefined = delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          outputTokens += Math.ceil(text.length / 4);
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        }
        if (Array.isArray(delta?.tool_calls)) {
          sawToolUse = true;
          for (const tc of delta.tool_calls as OpenAIToolCallDelta[]) {
            handleToolFragment(tc);
          }
        }
        if (choice?.finish_reason === 'tool_calls') sawToolUse = true;
        const usage = parsed?.usage;
        if (usage?.completion_tokens) outputTokens = usage.completion_tokens;
      } catch {
        // ignore malformed lines
      }
    }
  });

  upstream.on('end', () => {
    // close tool blocks in index order, then the text block
    const accs = [...toolAccs.values()].sort((a, b) => a.blockIndex - b.blockIndex);
    for (const acc of accs) {
      send({ type: 'content_block_stop', index: acc.blockIndex });
    }
    send({ type: 'content_block_stop', index: 0 });
    send({
      type: 'message_delta',
      delta: { stop_reason: sawToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    send({ type: 'message_stop' });
    res.end();
  });

  upstream.on('error', (err) => {
    try {
      send({ type: 'error', error: { type: 'api_error', message: err.message } });
      res.end();
    } catch {
      // response already closed
    }
  });
}
