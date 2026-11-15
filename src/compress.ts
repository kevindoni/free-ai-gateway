// Context compression: extractive summarization + message truncation (pure functions)
import type { ChatRequest } from './types.js';

type Message = ChatRequest['messages'][number];

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 8000;
const MAX_EXTRACTED_LINES = 10;

export function compressMessages(
  messages: ChatRequest['messages'],
  opts?: { maxMessages?: number; maxCharsPerMessage?: number },
): ChatRequest['messages'] {
  const maxMessages = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts?.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;

  const result = [...messages];

  if (result.length > maxMessages) {
    // Contiguous leading system block stays intact
    let middleStart = 0;
    while (middleStart < result.length && result[middleStart].role === 'system') middleStart++;
    const middleEnd = result.length - 1; // exclusive: last message stays

    if (middleEnd > middleStart) {
      const omitted = result.slice(middleStart, middleEnd);
      const extracted: string[] = [];
      for (const m of omitted) {
        for (const rawLine of m.content.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          const lower = line.toLowerCase();
          if (lower.startsWith('error') || lower.startsWith('important') || line.includes('TODO')) {
            extracted.push(line);
            if (extracted.length >= MAX_EXTRACTED_LINES) break;
          }
        }
        if (extracted.length >= MAX_EXTRACTED_LINES) break;
      }

      const header = `[earlier conversation summarized: ${omitted.length} messages omitted]`;
      const synthetic: Message = {
        role: 'system',
        content: extracted.length > 0 ? `${header}\n${extracted.join('\n')}` : header,
      };
      result.splice(middleStart, omitted.length, synthetic);
    }
  }

  return result.map((m) => truncateMessage(m, maxChars));
}

function truncateMessage(message: Message, maxChars: number): Message {
  if (message.content.length <= maxChars) return message;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.floor(maxChars * 0.25);
  const omitted = message.content.length - headLen - tailLen;
  return {
    ...message,
    content: `${message.content.slice(0, headLen)}\n...[truncated ${omitted} chars]...\n${message.content.slice(
      message.content.length - tailLen,
    )}`,
  };
}

export function estimateTokens(messages: ChatRequest['messages']): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.round(chars / 4);
}
